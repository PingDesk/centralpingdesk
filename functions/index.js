import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";

initializeApp();

const auth = getAuth();
const db = getFirestore();
const allowedRoles = new Set(["admin", "collaborator", "provider"]);
const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const telegramChatId = defineString("TELEGRAM_CHAT_ID");
const telegramAdminChatId = defineString("TELEGRAM_ADMIN_CHAT_ID");

function telegramField(label, value, maxLength = 500) {
  const text = typeof value === "string" && value.trim() ? value.trim() : "—";
  const clipped = text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  return `${label}: ${clipped}`;
}

async function sendTelegramMessage(chatId, message) {
  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken.value()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    throw new Error(`Telegram recusou a mensagem (HTTP ${response.status}): ${result.description ?? "erro desconhecido"}`);
  }
  return result.result;
}

async function claimNotification(claimId) {
  const claimRef = db.collection("telegramNotificationClaims").doc(claimId);
  const shouldSend = await db.runTransaction(async (transaction) => {
    const claimSnapshot = await transaction.get(claimRef);
    const claim = claimSnapshot.data();
    const updatedAt = claim?.updatedAt?.toMillis() ?? 0;
    if (claim?.status === "sent" || (claim?.status === "sending" && Date.now() - updatedAt < 5 * 60_000)) {
      return false;
    }
    transaction.set(claimRef, {
      status: "sending",
      attempts: (claim?.attempts ?? 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  return shouldSend ? claimRef : null;
}

async function sendClaimedNotification(claimRef, chatId, message, logLabel) {
  try {
    const result = await sendTelegramMessage(chatId, message);
    await claimRef.set({
      status: "sent",
      telegramMessageId: result.message_id ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  } catch (error) {
    await claimRef.set({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.error(`Falha ao enviar ${logLabel} ao Telegram.`, { notificationId: claimRef.id });
    throw error;
  }
}

export const notifyTelegramOnTicketCreated = onDocumentCreated(
  {
    document: "tickets/{ticketId}",
    region: "southamerica-east1",
    retry: true,
    secrets: [telegramBotToken],
  },
  async (event) => {
    const ticket = event.data?.data();
    if (!ticket) {
      throw new Error(`Novo chamado sem dados no evento do Firestore: ${event.params.ticketId}`);
    }

    const providerSnapshot = typeof ticket.providerId === "string"
      ? await db.collection("providers").doc(ticket.providerId).get()
      : null;
    if (!providerSnapshot?.exists) {
      throw new Error(`Provedor do chamado não encontrado: ${event.params.ticketId}`);
    }

    const ticketId = event.params.ticketId;
    const claimRef = await claimNotification(`ticket_${ticketId}`);
    if (!claimRef) {
      logger.info("Notificação do Telegram já enviada ou em processamento.", { ticketId });
      return;
    }

    const message = [
      "📩 Novo chamado registrado",
      telegramField("Provedor", providerSnapshot.data()?.name, 150),
      telegramField("Colaborador", ticket.collaboratorName, 150),
      telegramField("Cliente", ticket.customer, 200),
      telegramField("Endereço", ticket.address, 400),
      telegramField("Contato", ticket.contact, 150),
      telegramField("Protocolo", ticket.protocol, 150),
      telegramField("Assunto", ticket.subjectName, 150),
      telegramField("Descrição", ticket.description, 1500),
    ].join("\n");

    await sendClaimedNotification(claimRef, telegramChatId.value(), message, "notificação de novo chamado");
    logger.info("Notificação de novo chamado enviada ao Telegram.", { ticketId });
  },
);

export const notifyTelegramOnProviderComment = onDocumentCreated(
  {
    document: "ticketComments/{commentId}",
    region: "southamerica-east1",
    retry: true,
    secrets: [telegramBotToken],
  },
  async (event) => {
    const comment = event.data?.data();
    if (!comment) throw new Error(`Comentário sem dados no evento do Firestore: ${event.params.commentId}`);
    const claimRef = await claimNotification(`comment_${event.params.commentId}`);
    if (!claimRef) return;

    const message = [
      "💬 Comentário de provedor",
      telegramField("Provedor", comment.providerName, 150),
      telegramField("Protocolo", comment.protocol, 150),
      telegramField("Comentário", comment.comment, 2000),
    ].join("\n");
    await sendClaimedNotification(claimRef, telegramAdminChatId.value(), message, "comentário do provedor");
  },
);

function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function closingDateFor(provider, referenceDate) {
  const [year, month, day] = referenceDate.split("-").map(Number);
  const startDay = Math.max(1, Math.min(31, Number(provider.billingStartDay) || 1));
  const endDay = Math.max(0, Math.min(31, Number(provider.billingEndDay) || 0));
  const cycleStart = new Date(Date.UTC(year, month - 1 - (day < startDay ? 1 : 0), 1));
  const endMonthOffset = endDay > 0 && endDay < startDay ? 1 : 0;
  const endMonth = new Date(Date.UTC(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth() + endMonthOffset, 1));
  const lastDay = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() + 1, 0)).getUTCDate();
  const closingDay = endDay || lastDay;
  const actualDay = Math.min(closingDay, lastDay);
  return `${endMonth.getUTCFullYear()}-${String(endMonth.getUTCMonth() + 1).padStart(2, "0")}-${String(actualDay).padStart(2, "0")}`;
}

export const remindTelegramProviderClosingDay = onSchedule(
  {
    schedule: "45 23 * * *",
    timeZone: "America/Sao_Paulo",
    region: "southamerica-east1",
    retryCount: 3,
    secrets: [telegramBotToken],
  },
  async () => {
    const today = localDateKey();
    const providersSnapshot = await db.collection("providers").get();
    for (const providerSnapshot of providersSnapshot.docs) {
      const provider = providerSnapshot.data();
      if (closingDateFor(provider, today) !== today) continue;

      const providerName = typeof provider.name === "string" ? provider.name : providerSnapshot.id;
      const claimRef = await claimNotification(`closing_${providerSnapshot.id}_${today}`);
      if (!claimRef) continue;
      const message = [
        "📅 Lembrete de fechamento",
        `Hoje é dia de fechamento do provedor ${providerName}.`,
      ].join("\n");
      await sendClaimedNotification(claimRef, telegramAdminChatId.value(), message, "lembrete de fechamento");
    }
  },
);

export const manageUser = onCall({ region: "southamerica-east1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Faça login para gerenciar acessos.");
  }

  const actor = await db.collection("users").doc(request.auth.uid).get();
  if (actor.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Somente administradores podem gerenciar acessos.");
  }

  const data = request.data ?? {};
  const action = data.action;

  if (action === "create") {
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const email = typeof data.email === "string" ? data.email.trim() : "";
    const password = typeof data.password === "string" ? data.password : "";
    if (!name || !email || password.length < 8 || !allowedRoles.has(data.role)) {
      throw new HttpsError("invalid-argument", "Nome, e-mail, senha com 8 caracteres e perfil válido são obrigatórios.");
    }
    if (data.providerId && typeof data.providerId !== "string") {
      throw new HttpsError("invalid-argument", "Provedor inválido.");
    }

    let createdUser;
    try {
      createdUser = await auth.createUser({ email, password, displayName: name });
      await db.collection("users").doc(createdUser.uid).set({
        uid: createdUser.uid,
        name,
        email,
        role: data.role,
        ...(data.providerId ? { providerId: data.providerId } : {}),
        isOnline: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      if (createdUser) await auth.deleteUser(createdUser.uid);
      throw new HttpsError("internal", "Não foi possível criar o usuário.", { message: error.message });
    }
    return { uid: createdUser.uid };
  }

  if (action === "update") {
    const uid = typeof data.uid === "string" ? data.uid : "";
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!uid || !name || !allowedRoles.has(data.role)) {
      throw new HttpsError("invalid-argument", "Usuário, nome e perfil válido são obrigatórios.");
    }
    if (uid === request.auth.uid && data.role !== "admin") {
      throw new HttpsError("failed-precondition", "Você não pode remover seu próprio perfil de administrador.");
    }
    const profileRef = db.collection("users").doc(uid);
    const profile = await profileRef.get();
    if (!profile.exists) throw new HttpsError("not-found", "Perfil de usuário não encontrado.");
    const update = {
      name,
      role: data.role,
      ...(data.providerId ? { providerId: data.providerId } : { providerId: FieldValue.delete() }),
    };
    await Promise.all([
      profileRef.update(update),
      auth.updateUser(uid, { displayName: name }),
    ]);
    return { uid };
  }

  if (action === "delete") {
    const uid = typeof data.uid === "string" ? data.uid : "";
    if (!uid) throw new HttpsError("invalid-argument", "Usuário inválido.");
    if (uid === request.auth.uid) throw new HttpsError("failed-precondition", "Você não pode excluir seu próprio acesso.");
    await auth.deleteUser(uid);
    await db.collection("users").doc(uid).delete();
    return { uid };
  }

  throw new HttpsError("invalid-argument", "Ação de gerenciamento inválida.");
});
