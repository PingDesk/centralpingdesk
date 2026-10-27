import type { Actuation, Provider, Sale, Ticket, TicketLevel, TicketSubject, UserProfile } from "./types";

const providerId = "demo-provider";
const secondProviderId = "demo-provider-2";
const collaboratorId = "demo-collaborator";

function timestamp(date: Date) {
  return { toDate: () => new Date(date) };
}

function demoDate(monthOffset: number, day: number, hour = 10) {
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return new Date(month.getFullYear(), month.getMonth(), Math.min(day, lastDay), hour, 15);
}

const onlineSince = timestamp(new Date(Date.now() - 3_600_000));
const lastSeenAt = timestamp(new Date());

export const demoUsers: UserProfile[] = [
  {
    uid: "demo-admin",
    name: "Ana Administradora",
    email: "admin@demo.pingdesk.com.br",
    role: "admin",
    isOnline: true,
    onlineSince,
    lastSeenAt,
  },
  {
    uid: collaboratorId,
    name: "Lucas Colaborador",
    email: "colaborador@demo.pingdesk.com.br",
    role: "collaborator",
    providerId,
    isOnline: true,
    isPaused: false,
    onlineSince,
    lastSeenAt,
  },
  {
    uid: "demo-provider-user",
    name: "Marina Provedor",
    email: "provedor@demo.pingdesk.com.br",
    role: "provider",
    providerId,
    isOnline: true,
    onlineSince,
    lastSeenAt,
  },
];

export const demoProviders: Provider[] = [
  {
    id: providerId,
    name: "Conexão Fibra",
    cnpj: "12.345.678/0001-90",
    includedCalls: 5,
    fixedMonthly: 499,
    rates: { N1: 25, N2: 40, "Pré Venda": 15, Massivo: 120 },
    billingStartDay: 1,
    billingEndDay: 0,
    protocolPattern: "^CF-\\d{6}$",
    createdAt: timestamp(demoDate(-8, 1)),
  },
  {
    id: secondProviderId,
    name: "NetWave Internet",
    cnpj: "98.765.432/0001-10",
    includedCalls: 8,
    fixedMonthly: 649,
    rates: { N1: 22, N2: 38, "Pré Venda": 12, Massivo: 110 },
    billingStartDay: 1,
    billingEndDay: 0,
    protocolPattern: "^NW-\\d{6}$",
    createdAt: timestamp(demoDate(-8, 1)),
  },
];

const today = new Date();
const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

export const demoActuations: Actuation[] = [
  {
    id: "demo-actuation-1",
    providerId,
    providerName: "Conexão Fibra",
    collaboratorId,
    collaboratorName: "Lucas Colaborador",
    serviceDate: todayKey,
    startTime: "08:00",
    endTime: "12:00",
  },
  {
    id: "demo-actuation-2",
    providerId: secondProviderId,
    providerName: "NetWave Internet",
    collaboratorId,
    collaboratorName: "Lucas Colaborador",
    serviceDate: todayKey,
    startTime: "13:00",
    endTime: "17:00",
  },
];

export const demoSubjects: TicketSubject[] = [
  { id: "demo-subject-internet", providerId, name: "Sem conexão", level: "N1", defaultDescription: "Cliente informa que está sem conexão." },
  { id: "demo-subject-slow", providerId, name: "Lentidão", level: "N2", defaultDescription: "Cliente relata lentidão na navegação." },
  { id: "demo-subject-plan", providerId, name: "Contratação de plano", level: "Pré Venda", defaultDescription: "Cliente deseja conhecer os planos disponíveis." },
  { id: "demo-subject-outage", providerId, name: "Indisponibilidade na região", level: "Massivo", defaultDescription: "Falha massiva identificada na região." },
  { id: "demo-subject-internet-2", providerId: secondProviderId, name: "Sem conexão", level: "N1", defaultDescription: "Cliente informa que está sem conexão." },
  { id: "demo-subject-slow-2", providerId: secondProviderId, name: "Lentidão", level: "N2", defaultDescription: "Cliente relata lentidão na navegação." },
  { id: "demo-subject-plan-2", providerId: secondProviderId, name: "Contratação de plano", level: "Pré Venda", defaultDescription: "Cliente deseja conhecer os planos disponíveis." },
  { id: "demo-subject-outage-2", providerId: secondProviderId, name: "Indisponibilidade na região", level: "Massivo", defaultDescription: "Falha massiva identificada na região." },
];

const levelsByMonth: TicketLevel[][] = [
  ["N1", "N2", "Pré Venda"],
  ["N1", "N1", "Massivo"],
  ["N2", "Pré Venda", "N1"],
  ["N1", "N2", "N2"],
  ["Pré Venda", "N1", "Massivo"],
  ["N1", "N2", "Pré Venda", "Massivo", "N1", "N2", "Pré Venda"],
];

export const demoTickets: Ticket[] = levelsByMonth.flatMap((levels, monthIndex) =>
  levels.map((level, levelIndex) => {
    const number = 100001 + monthIndex * 3 + levelIndex;
    const createdAtDate = demoDate(monthIndex - 5, 5 + levelIndex * 6);
    const subject = demoSubjects.find((item) => item.level === level) ?? demoSubjects[0];
    const isOutOfPattern = monthIndex === 5 && levelIndex === 4;
    const isDuplicate = monthIndex === 5 && levelIndex === 6;
    return {
      id: `demo-ticket-${monthIndex}-${levelIndex}`,
      providerId,
      subjectId: subject.id,
      subjectName: subject.name,
      collaboratorId,
      collaboratorName: "Lucas Colaborador",
      protocol: isOutOfPattern ? "SEM-PADRAO-26" : isDuplicate ? "CF-100016" : `CF-${number}`,
      contact: ["(11) 98888-1200", "(11) 97777-3400", "(11) 96666-5600"][levelIndex % 3],
      customer: ["João da Silva", "Maria Oliveira", "Carlos Souza", "Fernanda Lima"][levelIndex % 4],
      address: `Rua ${["das Palmeiras", "do Ipê", "Central"][levelIndex % 3]}, ${120 + levelIndex} · São Paulo/SP`,
      level,
      description: subject.defaultDescription,
      clientCreatedAt: timestamp(createdAtDate),
      createdAt: timestamp(createdAtDate),
    };
  }),
);

export const demoSales: Sale[] = [
  {
    id: "demo-sale-1",
    ticketId: demoTickets.find((ticket) => ticket.level === "Pré Venda" && ticket.createdAt?.toDate().getMonth() === new Date().getMonth())?.id ?? "demo-ticket-sale",
    providerId,
    customer: "Fernanda Lima",
    planValue: 119.9,
    installationDate: demoDate(0, 29).toISOString().slice(0, 10),
    convertedAt: timestamp(demoDate(0, 12)),
  },
];
