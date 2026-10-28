import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowUpRight,
  BadgeDollarSign,
  Bell,
  Building2,
  CalendarDays,
  CalendarClock,
  BarChart3,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  FileSpreadsheet,
  Headset,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  MessageSquarePlus,
  Pencil,
  Pause,
  Plus,
  Play,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
  Wifi,
  X,
} from "lucide-react";
import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import * as XLSX from "xlsx";
import { auth, db, functions, isFirebaseConfigured } from "./firebase";
import { demoActuations, demoProviders, demoSales, demoSubjects, demoTickets, demoUsers } from "./demo";
import {
  ROLE_LABELS,
  TICKET_LEVELS,
  type Provider,
  type ProviderComment,
  type Actuation,
  type ArchivedClosing,
  type Sale,
  type Ticket,
  type TicketLevel,
  type TicketSubject,
  type UserProfile,
  type UserRole,
} from "./types";

type HandoffAlert = {
  id: string;
  providerName: string;
  endTime: string;
  remainingMinutes: number;
  nextCollaboratorName?: string;
  nextServiceDate?: string;
  nextStartTime?: string;
};

type View =
  | "Dashboard"
  | "Chamados"
  | "Registro em Massa"
  | "PowerShell"
  | "Pré Fechamento"
  | "Vendas"
  | "Provedores"
  | "Assuntos"
  | "Atuações"
  | "Acessos"
  | "Fechamento"
  | "Fechamentos Anteriores"
  | "Métrica Financeira";

const navigation: { name: View; icon: typeof LayoutDashboard }[] = [
  { name: "Dashboard", icon: LayoutDashboard },
  { name: "Chamados", icon: Headset },
  { name: "Vendas", icon: ArrowUpRight },
  { name: "Provedores", icon: Building2 },
  { name: "Assuntos", icon: MessageSquareText },
  { name: "Atuações", icon: CalendarClock },
  { name: "Acessos", icon: Users },
  { name: "Fechamento", icon: FileSpreadsheet },
  { name: "Fechamentos Anteriores", icon: Archive },
  { name: "Métrica Financeira", icon: BarChart3 },
];

const collaboratorNavigation: { name: View; icon: typeof LayoutDashboard }[] = [
  { name: "Dashboard", icon: LayoutDashboard },
  { name: "Chamados", icon: Headset },
  { name: "Registro em Massa", icon: FileSpreadsheet },
  { name: "PowerShell", icon: Terminal },
];

const providerNavigation: { name: View; icon: typeof LayoutDashboard }[] = [
  { name: "Dashboard", icon: LayoutDashboard },
  { name: "Chamados", icon: Headset },
  { name: "Pré Fechamento", icon: FileSpreadsheet },
  { name: "Fechamentos Anteriores", icon: Archive },
];

const emptyTicket = {
  providerId: "",
  subjectId: "",
  protocol: "",
  contact: "",
  customer: "",
  address: "",
  level: "N1" as TicketLevel,
  description: "",
};

const emptyProvider = {
  name: "",
  cnpj: "",
  includedCalls: 0,
  fixedMonthly: 0,
  n1: 0,
  n2: 0,
  preSale: 0,
  massive: 0,
  billingStartDay: 1,
  billingEndDay: 0,
  protocolPattern: "",
  diagnosticIpsText: "",
};

function firebaseError(error: unknown): string {
  return error instanceof Error ? error.message : "Não foi possível concluir a operação.";
}

function localDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ticketOpenedAt(ticket: Ticket): Date | undefined {
  return ticket.clientCreatedAt?.toDate() ?? ticket.createdAt?.toDate();
}

function ticketsNewestFirst(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) =>
    (ticketOpenedAt(b)?.getTime() ?? 0) - (ticketOpenedAt(a)?.getTime() ?? 0),
  );
}

function currency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value || 0);
}

function dateLabel(date?: Date): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function protocolWarning(provider: Provider | undefined, protocol: string): string {
  if (!provider?.protocolPattern || !protocol.trim()) return "";
  try {
    return new RegExp(provider.protocolPattern).test(protocol.trim())
      ? ""
      : `Tem certeza que é este provedor? O protocolo não corresponde ao padrão cadastrado para ${provider.name}.`;
  } catch {
    return `O padrão de protocolo cadastrado para ${provider.name} é inválido. Solicite a correção ao administrador.`;
  }
}

function isValidIpv4(value: string): boolean {
  const octets = value.trim().split(".");
  return octets.length === 4 && octets.every((octet) =>
    /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
  );
}

function providersMatchingProtocol(providers: Provider[], protocol: string): Provider[] {
  const value = protocol.trim();
  if (!value) return [];
  return providers.filter((provider) => {
    if (!provider.protocolPattern.trim()) return false;
    try {
      return new RegExp(provider.protocolPattern).test(value);
    } catch {
      return false;
    }
  });
}

function subjectProviderIds(subject: TicketSubject): string[] {
  return subject.providerIds ?? (subject.providerId ? [subject.providerId] : []);
}

function dateOnly(date?: Date): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(date);
}

function elapsed(since?: Date): string {
  if (!since) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}min`;
}

function periodFor(provider: Provider, date: Date): { start: Date; end: Date } {
  const startDay = Math.max(1, Math.min(31, provider.billingStartDay || 1));
  const endDay = Math.max(0, Math.min(31, provider.billingEndDay || 0));
  const year = date.getFullYear();
  let month = date.getMonth();
  if (date.getDate() < startDay) month -= 1;
  const startMonthLastDay = new Date(year, month + 1, 0).getDate();
  const start = new Date(year, month, Math.min(startDay, startMonthLastDay));
  let endMonth = month;
  if (endDay > 0 && endDay < startDay) endMonth += 1;
  const endMonthLastDay = new Date(year, endMonth + 1, 0).getDate();
  const end = new Date(year, endMonth, endDay || endMonthLastDay, 23, 59, 59, 999);
  return { start, end };
}

function Logo({ small = false, large = false }: { small?: boolean; large?: boolean }) {
  return (
    <div className={`brand ${small ? "brand-small" : ""} ${large ? "brand-large" : ""}`} aria-label="PingDesk">
      <img className="brand-mark" src="/android-chrome-192x192.png" alt="" />
      <span>Ping<span>Desk</span></span>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (user: User) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!auth) return;
    setLoading(true);
    setError("");
    try {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      await onLogin(credential.user);
    } catch (reason) {
      setError(firebaseError(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-grid" />
      <div className="login-top"><Logo large /><span className="secure-label"><ShieldCheck size={14} /> AMBIENTE SEGURO</span></div>
      <section className="login-layout">
        <div className="login-story">
          <div className="eyebrow"><span className="pulse-dot" /> CENTRAL DE OPERAÇÕES</div>
          <h1>Conectando pessoas.<br /><strong>Elevando a conexão.</strong></h1>
          <p>Seu centro de comando para chamados, provedores e resultados — em um só lugar.</p>
          <div className="login-stats">
            <div><Wifi size={18} /><b>24/7</b><span>Operação conectada</span></div>
            <div><Activity size={18} /><b>Tempo real</b><span>Visão da operação</span></div>
          </div>
        </div>
        <form className="login-card" onSubmit={submit}>
          <div className="card-kicker">BEM-VINDO À CENTRAL</div>
          <h2>Acesse sua conta</h2>
          <p>Entre com seu e-mail e senha cadastrados.</p>
          <label>E-mail<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@provedor.com.br" /></label>
          <label>Senha<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" /></label>
          {error && <div className="notice error-notice">{error}</div>}
          <button className="button primary wide" disabled={loading}>{loading ? "Entrando..." : "Entrar na central"} <ArrowUpRight size={16} /></button>
          <div className="login-foot"><ShieldCheck size={15} /> Acesso protegido pelo Firebase</div>
        </form>
      </section>
      <footer className="login-footer">PINGDESK <span>·</span> HELP DESK ESPECIALIZADO PARA PROVEDORES</footer>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState<View>("Dashboard");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [subjects, setSubjects] = useState<TicketSubject[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [providerComments, setProviderComments] = useState<ProviderComment[]>([]);
  const [archivedClosings, setArchivedClosings] = useState<ArchivedClosing[]>([]);
  const [archivedTickets, setArchivedTickets] = useState<Ticket[]>([]);
  const [archivedSales, setArchivedSales] = useState<Sale[]>([]);
  const [actuations, setActuations] = useState<Actuation[]>(() => isFirebaseConfigured ? [] : demoActuations);
  const [scheduledActuations, setScheduledActuations] = useState<Actuation[]>(() => isFirebaseConfigured ? [] : demoActuations);
  const [handoffAlerts, setHandoffAlerts] = useState<HandoffAlert[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [accessPreset, setAccessPreset] = useState<{ role: UserRole; providerId: string } | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseToast, setPauseToast] = useState("");
  const [pauseNotifications, setPauseNotifications] = useState<Array<{ id: string; collaboratorName: string; createdAt?: { toDate: () => Date } }>>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsSeenAt, setNotificationsSeenAt] = useState(0);
  const demoMode = !isFirebaseConfigured;

  const isAdmin = profile?.role === "admin";
  const isCollaborator = profile?.role === "collaborator";
  const visibleNavigation = isAdmin
    ? navigation
    : profile?.role === "provider"
      ? providerNavigation
      : collaboratorNavigation;
  const notificationCount = profile?.role === "admin"
    ? providerComments.filter((comment) => (comment.createdAt?.toDate().getTime() ?? 0) > notificationsSeenAt).length
    : profile?.role === "collaborator"
      ? pauseNotifications.filter((item) => (item.createdAt?.toDate().getTime() ?? 0) > notificationsSeenAt).length
      : 0;

  const loadData = useCallback(async () => {
    if (!db || !profile) return;
    setBusy(true);
    setArchivedClosings([]);
    setArchivedTickets([]);
    setArchivedSales([]);
    setScheduledActuations([]);
    setHandoffAlerts([]);
    if (!isAdmin) setUsers([]);
    try {
      let providerRows: Provider[] = [];
      if (isAdmin) {
        const providerSnapshot = await getDocs(query(collection(db, "providers"), orderBy("name")));
        providerRows = providerSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Provider);
      } else if (isCollaborator) {
        const providerSnapshot = await getDocs(query(collection(db, "providers"), orderBy("name")));
        providerRows = providerSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Provider);
      } else if (profile.providerId) {
        const providerSnapshot = await getDoc(doc(db, "providers", profile.providerId));
        if (providerSnapshot.exists()) providerRows = [{ id: providerSnapshot.id, ...providerSnapshot.data() } as Provider];
      }
      setProviders(providerRows);

      if (isAdmin) {
        const subjectSnapshot = await getDocs(collection(db, "subjects"));
        setSubjects(subjectSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as TicketSubject));
      } else if (isCollaborator) {
        const subjectSnapshot = await getDocs(collection(db, "subjects"));
        setSubjects(subjectSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as TicketSubject));
      } else {
        setSubjects([]);
      }

      const ticketConstraints = [orderBy("createdAt", "desc")];
      const ticketSnapshot = isAdmin
        ? await getDocs(query(collection(db, "tickets"), ...ticketConstraints))
        : !isCollaborator && profile.providerId
          ? await getDocs(query(collection(db, "tickets"), where("providerId", "==", profile.providerId), ...ticketConstraints))
          : null;
      const loadedTickets = ticketSnapshot?.docs.map((item) => ({ id: item.id, ...item.data() }) as Ticket) ?? [];
      setTickets(ticketsNewestFirst(loadedTickets.filter((ticket) => !ticket.archiveId)));
      setArchivedTickets(ticketsNewestFirst(loadedTickets.filter((ticket) => Boolean(ticket.archiveId))));

      if (isAdmin) {
        const salesSnapshot = await getDocs(query(collection(db, "sales"), orderBy("convertedAt", "desc")));
        const loadedSales = salesSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Sale);
        setSales(loadedSales.filter((sale) => !sale.archiveId));
        setArchivedSales(loadedSales.filter((sale) => Boolean(sale.archiveId)));
      } else if (profile.role === "provider" && profile.providerId) {
        const salesSnapshot = await getDocs(query(collection(db, "sales"), where("providerId", "==", profile.providerId)));
        const loadedSales = salesSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Sale);
        setSales(loadedSales.filter((sale) => !sale.archiveId));
        setArchivedSales(loadedSales.filter((sale) => Boolean(sale.archiveId)));
      } else {
        setSales([]);
        setProviderComments([]);
        setArchivedSales([]);
      }

      const archivedSnapshot = isAdmin
        ? await getDocs(collection(db, "archivedClosings"))
        : profile.role === "provider" && profile.providerId
          ? await getDocs(query(collection(db, "archivedClosings"), where("providerId", "==", profile.providerId)))
          : null;
      setArchivedClosings((archivedSnapshot?.docs.map((item) => ({ id: item.id, ...item.data() }) as ArchivedClosing) ?? [])
        .sort((a, b) => b.endDate.localeCompare(a.endDate)));

      if (isAdmin) {
        try {
          const actuationSnapshot = await getDocs(query(collection(db, "actuations"), orderBy("serviceDate", "desc")));
          setActuations(actuationSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Actuation));
        } catch (reason) {
          setActuations([]);
          setNotice(`Erro ao carregar atuações: ${firebaseError(reason)}`);
        }
      } else if (!isCollaborator) setActuations([]);
    } catch (reason) {
      setNotice(`Erro ao carregar dados: ${firebaseError(reason)}`);
    } finally {
      setBusy(false);
    }
  }, [profile, isAdmin, isCollaborator]);

  function enterDemo(demoProfile: UserProfile) {
    setProfile(demoProfile);
    setView("Dashboard");
    setProviders(demoProviders);
    setSubjects(demoProfile.role === "collaborator"
      ? demoSubjects
      : demoSubjects.filter((subject) => subjectProviderIds(subject).includes(demoProfile.providerId ?? "")));
    const archivedTicketIds = new Set(archivedTickets.map((ticket) => ticket.id));
    setTickets(demoProfile.role === "collaborator"
      ? []
      : ticketsNewestFirst(demoTickets.filter((ticket) => (demoProfile.role === "admin" || ticket.providerId === demoProfile.providerId) && !archivedTicketIds.has(ticket.id))));
    setUsers(demoUsers);
    const archivedSaleIds = new Set(archivedSales.map((sale) => sale.id));
    setSales(demoSales.filter((sale) => (demoProfile.role === "admin" || sale.providerId === demoProfile.providerId) && !archivedSaleIds.has(sale.id)));
    setNotice("");
  }

  function addDemoTicket(ticket: Ticket) {
    setTickets((current) => ticketsNewestFirst([...current, ticket]));
  }

  useEffect(() => {
    const firebaseAuth = auth;
    const firestore = db;
    if (!firebaseAuth) {
      setAuthLoading(false);
      return;
    }
    return onAuthStateChanged(firebaseAuth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser || !firestore) {
        setProfile(null);
        setTickets([]);
        setSubjects([]);
        setProviders([]);
        setUsers([]);
        setSales([]);
        setPauseNotifications([]);
        setNotificationsOpen(false);
        if (!demoMode) setProviderComments([]);
        setArchivedClosings([]);
        setArchivedTickets([]);
        setArchivedSales([]);
        if (!demoMode) setActuations([]);
        setAuthLoading(false);
        return;
      }
      try {
        const profileSnapshot = await getDoc(doc(firestore, "users", nextUser.uid));
        if (!profileSnapshot.exists()) {
          await signOut(firebaseAuth);
          setNotice("Este usuário ainda não possui um perfil autorizado na central.");
          setProfile(null);
          setTickets([]);
          setSubjects([]);
          setProviders([]);
          setUsers([]);
          setSales([]);
          setActuations([]);
          setAuthLoading(false);
          return;
        }
        setProfile({ uid: nextUser.uid, ...profileSnapshot.data() } as UserProfile);
      } catch (reason) {
        setNotice(`Não foi possível validar seu acesso: ${firebaseError(reason)}`);
        await signOut(firebaseAuth);
      } finally {
        setAuthLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!profile || !db) return;
    const lastSeen = profile.lastSeenAt?.toDate().getTime() ?? 0;
    const continuingSession = profile.isOnline && Date.now() - lastSeen < 120_000;
    const resetStalePause = profile.role === "collaborator" && !continuingSession && profile.isPaused;
    const pausedAt = profile.pauseSince?.toDate().getTime();
    const resetPauseDuration = pausedAt
      ? Math.max(0, Math.floor((Date.now() - pausedAt) / 1000))
      : profile.lastPauseDurationSeconds ?? 0;
    void updateDoc(doc(db, "users", profile.uid), {
      isOnline: true,
      lastSeenAt: serverTimestamp(),
      ...(!continuingSession ? { onlineSince: serverTimestamp() } : {}),
      ...(resetStalePause
        ? {
            isPaused: false,
            pauseSince: null,
            lastPauseAt: serverTimestamp(),
            lastPauseDurationSeconds: resetPauseDuration,
          }
        : {}),
    }).then(() => {
      if (auth?.currentUser?.uid !== profile.uid) return;
      if (!continuingSession || resetStalePause) {
        setProfile({
          ...profile,
          isOnline: true,
          lastSeenAt: { toDate: () => new Date() },
          ...(!continuingSession ? { onlineSince: { toDate: () => new Date() } } : {}),
          ...(resetStalePause
            ? {
                isPaused: false,
                pauseSince: null,
                lastPauseDurationSeconds: resetPauseDuration,
              }
            : {}),
        });
      }
    }).catch((reason) => setNotice(`Falha ao atualizar presença: ${firebaseError(reason)}`));
  }, [profile]);

  useEffect(() => {
    if (profile) void loadData();
  }, [profile, loadData]);

  useEffect(() => {
    const firestore = db;
    if (!profile || !firestore) return;
    const timer = window.setInterval(() => {
      void updateDoc(doc(firestore, "users", profile.uid), {
        isOnline: true,
        lastSeenAt: serverTimestamp(),
      }).catch((reason) => setNotice(`Falha ao atualizar presença: ${firebaseError(reason)}`));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [profile]);

  useEffect(() => {
    if (!isAdmin || !db) return;
    return onSnapshot(
      query(collection(db, "users"), orderBy("name")),
      (snapshot) => setUsers(snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }) as UserProfile)),
      (error) => setNotice(`Falha ao atualizar presença da equipe: ${firebaseError(error)}`),
    );
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin || !db) return;
    return onSnapshot(
      query(collection(db, "ticketComments"), orderBy("createdAt", "desc"), limit(20)),
      (snapshot) => setProviderComments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as ProviderComment)),
      (error) => setNotice(`Falha ao receber comentários dos provedores: ${firebaseError(error)}`),
    );
  }, [isAdmin]);

  useEffect(() => {
    if (profile?.role !== "collaborator" || !db) return;
    return onSnapshot(
      query(
        collection(db, "actuations"),
        where("collaboratorId", "==", profile.uid),
        where("serviceDate", "==", localDateString(new Date())),
      ),
      (snapshot) => setActuations(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Actuation)),
      (error) => setNotice(`Falha ao atualizar suas atuações: ${firebaseError(error)}`),
    );
  }, [profile?.uid, profile?.role]);

  useEffect(() => {
    if (profile?.role !== "collaborator" || !db) return;
    const today = localDateString(new Date());
    const future = new Date();
    future.setDate(future.getDate() + 60);
    const throughDate = localDateString(future);
    return onSnapshot(
      query(
        collection(db, "actuations"),
        where("serviceDate", ">=", today),
        where("serviceDate", "<=", throughDate),
        orderBy("serviceDate"),
        limit(500),
      ),
      (snapshot) => setScheduledActuations(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Actuation)),
      (error) => setNotice(`Falha ao carregar as próximas responsabilidades: ${firebaseError(error)}`),
    );
  }, [profile?.uid, profile?.role]);

  useEffect(() => {
    if (profile?.role !== "collaborator") {
      setHandoffAlerts([]);
      return;
    }
    const collaboratorUid = profile.uid;

    function updateHandoffAlerts() {
      const now = new Date();
      const today = localDateString(now);
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const upcoming = scheduledActuations
        .filter((actuation) => actuation.serviceDate >= today)
        .sort((a, b) => `${a.serviceDate}T${a.startTime}`.localeCompare(`${b.serviceDate}T${b.startTime}`));
      const alerts = upcoming.flatMap((actuation) => {
        if (actuation.collaboratorId !== collaboratorUid || actuation.serviceDate !== today) return [];
        const [endHour, endMinute] = actuation.endTime.split(":").map(Number);
        const [startHour, startMinute] = actuation.startTime.split(":").map(Number);
        const endMinutes = endHour * 60 + endMinute;
        const startMinutes = startHour * 60 + startMinute;
        const minutesRemaining = endMinutes - currentMinutes;
        if (currentMinutes < startMinutes || minutesRemaining <= 0 || minutesRemaining > 15) return [];

        const nextResponsibility = upcoming.find((candidate) =>
          candidate.providerId === actuation.providerId &&
          candidate.id !== actuation.id &&
          `${candidate.serviceDate}T${candidate.startTime}` >= `${actuation.serviceDate}T${actuation.endTime}`,
        );
        return [{
          id: actuation.id,
          providerName: actuation.providerName,
          endTime: actuation.endTime,
          remainingMinutes: minutesRemaining,
          ...(nextResponsibility ? {
            nextCollaboratorName: nextResponsibility.collaboratorName,
            nextServiceDate: nextResponsibility.serviceDate,
            nextStartTime: nextResponsibility.startTime,
          } : {}),
        } satisfies HandoffAlert];
      });
      setHandoffAlerts(alerts);
    }

    updateHandoffAlerts();
    const interval = window.setInterval(updateHandoffAlerts, 30_000);
    return () => window.clearInterval(interval);
  }, [profile?.uid, profile?.role, scheduledActuations]);

  useEffect(() => {
    if (profile?.role !== "collaborator" || profile.isPaused || !db) return;
    const subscriptionStartedAt = Timestamp.fromDate(new Date());
    return onSnapshot(
      query(
        collection(db, "pauseEvents"),
        where("createdAt", ">", subscriptionStartedAt),
        orderBy("createdAt", "desc"),
        limit(20),
      ),
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type !== "added") continue;
          const event = change.doc.data();
          if (event.actorUid !== profile.uid && typeof event.collaboratorName === "string") {
            setPauseToast(`${event.collaboratorName} entrou em pausa.`);
            setPauseNotifications((current) => [
              { id: change.doc.id, collaboratorName: event.collaboratorName, createdAt: event.createdAt },
              ...current.filter((notification) => notification.id !== change.doc.id),
            ].slice(0, 20));
          }
        }
      },
      (error) => setNotice(`Falha ao receber avisos de pausa: ${firebaseError(error)}`),
    );
  }, [profile?.uid, profile?.role, profile?.isPaused]);

  useEffect(() => {
    if (!pauseToast) return;
    const timer = window.setTimeout(() => setPauseToast(""), 8_000);
    return () => window.clearTimeout(timer);
  }, [pauseToast]);

  async function handleLogin(firebaseUser: User) {
    if (!db) return;
    const snapshot = await getDoc(doc(db, "users", firebaseUser.uid));
    if (!snapshot.exists()) {
      await signOut(auth!);
      setNotice("Usuário autenticado, mas sem perfil autorizado. Solicite acesso ao administrador.");
      return;
    }
    const userProfile = { uid: firebaseUser.uid, ...snapshot.data() } as UserProfile;
    const lastSeen = userProfile.lastSeenAt?.toDate().getTime() ?? 0;
    const continuingSession = userProfile.isOnline && Date.now() - lastSeen < 120_000;
    await updateDoc(doc(db, "users", firebaseUser.uid), {
      isOnline: true,
      lastSeenAt: serverTimestamp(),
      ...(!continuingSession ? { onlineSince: serverTimestamp() } : {}),
    });
    setProfile(userProfile);
  }

  async function togglePause() {
    if (!profile || profile.role !== "collaborator" || pauseBusy) return;
    const enteringPause = !profile.isPaused;
    if (!db && demoMode) {
      setProfile({ ...profile, isPaused: enteringPause });
      setNotice(`Demonstração: status alterado para ${enteringPause ? "pausa" : "ativo"}. Essa mudança não será salva.`);
      return;
    }
    if (!db) return;
    setPauseBusy(true);
    try {
      const pausedAt = profile.pauseSince?.toDate().getTime();
      const pauseDurationSeconds = pausedAt
        ? Math.max(0, Math.floor((Date.now() - pausedAt) / 1000))
        : profile.lastPauseDurationSeconds ?? 0;
      await updateDoc(doc(db, "users", profile.uid), {
        isPaused: enteringPause,
        lastSeenAt: serverTimestamp(),
        pauseSince: enteringPause ? serverTimestamp() : null,
        ...(!enteringPause
          ? { lastPauseAt: serverTimestamp(), lastPauseDurationSeconds: pauseDurationSeconds }
          : {}),
      });
      setProfile({
        ...profile,
        isPaused: enteringPause,
        lastSeenAt: { toDate: () => new Date() },
        pauseSince: enteringPause ? { toDate: () => new Date() } : null,
        ...(!enteringPause ? { lastPauseDurationSeconds: pauseDurationSeconds } : {}),
      });
      if (enteringPause) {
        try {
          await setDoc(doc(collection(db, "pauseEvents")), {
            actorUid: profile.uid,
            collaboratorName: profile.name,
            createdAt: serverTimestamp(),
          });
        } catch (error) {
          setNotice(`Status alterado para pausa, mas não foi possível notificar os colegas: ${firebaseError(error)}`);
        }
      }
    } catch (error) {
      setNotice(`Não foi possível alterar seu status: ${firebaseError(error)}`);
    } finally {
      setPauseBusy(false);
    }
  }

  async function addProviderComment(ticket: Ticket, comment: string) {
    if (profile?.role !== "provider") {
      setNotice("Somente o acesso provedor pode incluir comentários nos chamados.");
      return;
    }
    const provider = providers.find((item) => item.id === profile.providerId);
    if (!provider || provider.id !== ticket.providerId) {
      setNotice("Este chamado não pertence ao provedor vinculado a este acesso.");
      return;
    }
    const trimmedComment = comment.trim();
    if (!trimmedComment || trimmedComment.length > 2000) {
      setNotice("O comentário deve ter entre 1 e 2.000 caracteres.");
      return;
    }
    try {
      if (!db && demoMode) {
        setProviderComments((current) => [{
          id: `demo-comment-${Date.now()}`,
          ticketId: ticket.id,
          providerId: provider.id,
          providerName: provider.name,
          protocol: ticket.protocol,
          comment: trimmedComment,
          authorUid: profile.uid,
          createdAt: { toDate: () => new Date() },
        }, ...current]);
      } else {
        if (!db) throw new Error("Firestore não está configurado.");
        await setDoc(doc(collection(db, "ticketComments")), {
          ticketId: ticket.id,
          providerId: provider.id,
          providerName: provider.name,
          protocol: ticket.protocol,
          comment: trimmedComment,
          authorUid: profile.uid,
          createdAt: serverTimestamp(),
        });
      }
      setNotice(`Comentário incluído no protocolo ${ticket.protocol}.`);
    } catch (error) {
      setNotice(`Não foi possível incluir o comentário: ${firebaseError(error)}`);
      throw error;
    }
  }

  async function logout() {
    try {
      if (db && profile) {
        const sessionStartedAt = profile.onlineSince?.toDate().getTime();
        const durationSeconds = sessionStartedAt ? Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000)) : 0;
        await updateDoc(doc(db, "users", profile.uid), {
          isOnline: false,
          lastSeenAt: serverTimestamp(),
          lastOnlineDurationSeconds: durationSeconds,
        });
      }
    } catch (error) {
      setNotice(`Presença não atualizada ao sair: ${firebaseError(error)}`);
    } finally {
      if (auth) await signOut(auth);
      setProfile(null);
      setUser(null);
      setTickets([]);
      setSubjects([]);
      setProviders([]);
      setUsers([]);
      setSales([]);
      if (!demoMode) setProviderComments([]);
      if (!demoMode) setActuations([]);
      setView("Dashboard");
    }
  }

  async function archiveClosing(report: ReturnType<typeof calculateClosing>, provider: Provider) {
    const startDate = localDateString(report.start);
    const endDate = localDateString(report.end);
    const archiveId = `${provider.id}_${startDate}_${endDate}`;
    if (report.end.getTime() >= new Date(`${localDateString(new Date())}T00:00:00`).getTime()) {
      setNotice("Este ciclo ainda não foi encerrado e não pode ser arquivado.");
      return;
    }
    if (archivedClosings.some((archive) => archive.id === archiveId)) {
      setNotice("Este fechamento já está arquivado.");
      return;
    }
    const writeCount = 1 + report.tickets.length + report.salesInPeriod.length;
    if (!demoMode && writeCount > 500) {
      setNotice("Este fechamento excede o limite de operações seguras do Firestore. Solicite ao suporte o arquivamento deste ciclo.");
      return;
    }
    const archivedAt = new Date();
    const archive: ArchivedClosing = {
      id: archiveId,
      providerId: provider.id,
      providerName: provider.name,
      startDate,
      endDate,
      ticketCount: report.tickets.length,
      saleCount: report.salesInPeriod.length,
      fixed: report.fixed,
      excess: report.excess,
      total: report.total,
      includedUsed: report.includedUsed,
      includedLimit: report.includedLimit,
      excessCount: report.excessCount,
      salesTotal: report.salesInPeriod.reduce((sum, sale) => sum + sale.planValue, 0),
      archivedAt: { toDate: () => archivedAt },
    };
    const closingTickets = report.tickets.map((ticket) => ({
      ...ticket,
      archiveId,
      archiveChargeLabel: report.charges.get(ticket.id)?.label ?? "Não faturável",
      archiveChargeAmount: report.charges.get(ticket.id)?.amount ?? 0,
    }));
    const closingSales = report.salesInPeriod.map((sale) => ({ ...sale, archiveId }));

    try {
      if (!demoMode) {
        if (!db) throw new Error("Firestore não está configurado.");
        const batch = writeBatch(db);
        const closingRef = doc(db, "archivedClosings", archiveId);
        batch.set(closingRef, {
          ...archive,
          archivedAt: serverTimestamp(),
        });
        for (const ticket of closingTickets) {
          batch.update(doc(db, "tickets", ticket.id), {
            archiveId,
            archiveChargeLabel: ticket.archiveChargeLabel,
            archiveChargeAmount: ticket.archiveChargeAmount,
          });
        }
        for (const sale of closingSales) {
          batch.update(doc(db, "sales", sale.id), { archiveId });
        }
        await batch.commit();
      }
      const ticketIds = new Set(closingTickets.map((ticket) => ticket.id));
      const saleIds = new Set(closingSales.map((sale) => sale.id));
      setArchivedClosings((current) => [...current.filter((item) => item.id !== archiveId), archive]
        .sort((a, b) => b.endDate.localeCompare(a.endDate)));
      setArchivedTickets((current) => [...current.filter((item) => !ticketIds.has(item.id)), ...closingTickets]);
      setArchivedSales((current) => [...current.filter((item) => !saleIds.has(item.id)), ...closingSales]);
      setTickets((current) => current.filter((ticket) => !ticketIds.has(ticket.id)));
      setSales((current) => current.filter((sale) => !saleIds.has(sale.id)));
      setNotice(`Fechamento de ${provider.name} arquivado. Os atendimentos foram removidos dos registros ativos.`);
    } catch (error) {
      setNotice(`Não foi possível arquivar o fechamento: ${firebaseError(error)}`);
    }
  }

  if (!isFirebaseConfigured && !profile) return <SetupScreen onDemoLogin={enterDemo} />;
  if (authLoading) return <div className="loading-screen"><Logo /><span className="loader" />Verificando acesso seguro...</div>;
  if ((!user && !demoMode) || !profile) return <><Login onLogin={handleLogin} />{notice && <div className="toast error-notice">{notice}<button onClick={() => setNotice("")}><X size={15} /></button></div>}</>;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand"><Logo /><button className="icon-button mobile-close" onClick={() => setMobileMenu(false)} aria-label="Fechar menu"><X size={18} /></button></div>
        <div className="workspace-label">ESPAÇO DE TRABALHO</div>
        <div className="workspace-card"><span className="workspace-icon"><Building2 size={17} /></span><span><b>{providerName(profile, providers)}</b><small>{ROLE_LABELS[profile.role]}</small></span><ChevronDown size={14} /></div>
        <nav className="side-nav">
          <div className="nav-caption">MENU PRINCIPAL</div>
          {visibleNavigation.map(({ name, icon: Icon }) => (
            <button key={name} onClick={() => { setView(name); setMobileMenu(false); }} className={`nav-item ${view === name ? "active" : ""}`}>
              <Icon size={18} /><span>{name === "Chamados" && isCollaborator ? "Registro de Chamados" : name}</span>{name === "Chamados" && !isCollaborator && <span className="nav-count">{tickets.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a className="support-card" href="https://wa.me/554732300424" target="_blank" rel="noreferrer"><CircleHelp size={17} /><span><b>Precisa de ajuda?</b><small>Fale com a equipe PingDesk</small></span><ArrowUpRight size={14} /></a>
          <div className="user-card"><div className="avatar">{initials(profile.name)}</div><span className="user-card-info"><b>{profile.name}</b><small>{profile.email}</small></span><button className="icon-button" onClick={logout} title="Sair"><LogOut size={17} /></button></div>
        </div>
      </aside>
      {mobileMenu && <button className="mobile-backdrop" onClick={() => setMobileMenu(false)} aria-label="Fechar menu" />}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="Abrir menu"><Menu size={20} /></button>
          <div className="breadcrumbs"><span>Central</span><span className="crumb-separator">/</span><b>{displayView(view, profile.role)}</b></div>
          <div className="topbar-right"><span className="live-indicator"><i /> Operação ativa</span><div className="notification-control"><button className="icon-button notification-button" aria-label="Notificações" aria-expanded={notificationsOpen} onClick={() => { setNotificationsOpen((open) => !open); setNotificationsSeenAt(Date.now()); }}><Bell size={18} />{notificationCount > 0 && <i />}</button>{notificationsOpen && <section className="notification-panel" aria-label="Notificações recentes"><div className="notification-panel-heading"><b>{profile.role === "provider" ? "Chamados recentes" : "Notificações"}</b><button className="icon-button" aria-label="Fechar notificações" onClick={() => setNotificationsOpen(false)}><X size={15} /></button></div>{profile.role === "admin" ? providerComments.length ? providerComments.slice(0, 8).map((comment) => <article className="notification-item" key={comment.id}><MessageSquareText size={15} /><span><b>Comentário do provedor {comment.providerName}</b><small>Protocolo {comment.protocol} · {dateLabel(comment.createdAt?.toDate())}</small><small>{comment.comment}</small></span></article>) : <p className="notification-empty">Nenhum comentário novo dos provedores.</p> : profile.role === "collaborator" ? pauseNotifications.length ? pauseNotifications.slice(0, 8).map((item) => <article className="notification-item" key={item.id}><Pause size={15} /><span><b>{item.collaboratorName} entrou em pausa</b><small>{dateLabel(item.createdAt?.toDate())}</small></span></article>) : <p className="notification-empty">Nenhum aviso de pausa recebido nesta sessão.</p> : tickets.length ? tickets.slice(0, 8).map((ticket) => <article className="notification-item" key={ticket.id}><Headset size={15} /><span><b>Protocolo {ticket.protocol}</b><small>{ticket.customer} · {dateLabel(ticket.createdAt?.toDate())}</small></span></article>) : <p className="notification-empty">Nenhum chamado recente para este provedor.</p>}</section>}</div><div className="top-avatar">{initials(profile.name)}</div></div>
        </header>
        <div className="page-content">
          {demoMode && <div className="notice demo-notice"><ShieldCheck size={15} /> Modo demonstração: dados fictícios. Alterações valem apenas nesta sessão e não são enviadas ao Firebase ou Telegram.</div>}
          {notice && <div className="notice global-notice">{notice}<button onClick={() => setNotice("")}><X size={15} /></button></div>}
          <PageHeading view={view} profile={profile} onRefresh={loadData} />
          {busy && <div className="sync-label"><span className="loader tiny" /> Sincronizando dados...</div>}
          {view === "Dashboard" && <Dashboard tickets={tickets} historicalTickets={[...tickets, ...archivedTickets]} providers={providers} users={users} sales={sales} actuations={actuations} handoffAlerts={handoffAlerts} providerComments={providerComments} profile={profile} onTogglePause={togglePause} pauseBusy={pauseBusy} />}
          {view === "Chamados" && <Calls tickets={tickets} subjects={subjects} providers={providers} users={users} profile={profile} demoMode={demoMode} onDemoCreate={addDemoTicket} onAddComment={addProviderComment} onReload={loadData} setNotice={setNotice} />}
          {view === "Registro em Massa" && isCollaborator && <MassTicketRegistration providers={providers} profile={profile} demoMode={demoMode} onDemoCreate={addDemoTicket} onReload={loadData} setNotice={setNotice} />}
          {view === "PowerShell" && isCollaborator && <PowerShellTools providers={providers} />}
          {view === "Pré Fechamento" && profile.role === "provider" && <Closing tickets={tickets} providers={providers} sales={sales} profile={profile} archivedClosings={archivedClosings} onArchive={archiveClosing} />}
          {view === "Vendas" && isAdmin && <Sales tickets={tickets} providers={providers} sales={sales} onReload={loadData} setNotice={setNotice} />}
          {view === "Provedores" && isAdmin && <Providers providers={providers} onReload={loadData} setNotice={setNotice} onCreateAccess={(provider) => { setAccessPreset({ role: "provider", providerId: provider.id }); setView("Acessos"); }} />}
          {view === "Assuntos" && isAdmin && <Subjects subjects={subjects} providers={providers} demoMode={demoMode} onDemoChange={setSubjects} onReload={loadData} setNotice={setNotice} />}
          {view === "Atuações" && isAdmin && <Actuations actuations={actuations} providers={providers} users={users} demoMode={demoMode} onDemoChange={setActuations} onReload={loadData} setNotice={setNotice} />}
          {view === "Acessos" && isAdmin && <Accesses users={users} providers={providers} demoMode={demoMode} onDemoChange={setUsers} accessPreset={accessPreset} onClearPreset={() => setAccessPreset(null)} onReload={loadData} setNotice={setNotice} />}
          {view === "Fechamento" && isAdmin && <Closing tickets={tickets} providers={providers} sales={sales} profile={profile} archivedClosings={archivedClosings} onArchive={archiveClosing} />}
          {view === "Fechamentos Anteriores" && <ArchivedClosingsList archives={archivedClosings.filter((archive) => profile.role === "admin" || archive.providerId === profile.providerId)} tickets={archivedTickets} sales={archivedSales} activeTickets={tickets} activeSales={sales} providers={providers} profile={profile} onArchive={archiveClosing} />}
          {view === "Métrica Financeira" && isAdmin && <FinancialMetrics tickets={tickets} providers={providers} sales={sales} archivedClosings={archivedClosings} />}
        </div>
      </main>
      {pauseToast && <div className="toast pause-toast" role="status"><span className="pause-toast-icon"><Pause size={17} /></span><span>{pauseToast}</span><button onClick={() => setPauseToast("")} aria-label="Fechar aviso"><X size={15} /></button></div>}
    </div>
  );
}

function SetupScreen({ onDemoLogin }: { onDemoLogin: (profile: UserProfile) => void }) {
  return (
    <main className="setup-page">
      <div className="setup-card"><Logo large /><h1>Acesse a central</h1><p>Escolha um perfil para visualizar a demonstração.</p><div className="demo-profile-list">{demoUsers.map((demoUser) => <button className="button outline demo-profile-button" key={demoUser.uid} onClick={() => onDemoLogin(demoUser)}><span className={`role-pill role-${demoUser.role}`}>{ROLE_LABELS[demoUser.role]}</span><span>{demoUser.name}</span><ArrowUpRight size={15} /></button>)}</div></div>
    </main>
  );
}

function providerName(profile: UserProfile, providers: Provider[]) {
  return profile.providerId
    ? providers.find((provider) => provider.id === profile.providerId)?.name ?? "Meu provedor"
    : "PingDesk Central";
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}

function displayView(view: View, role: UserRole) {
  return view === "Chamados" && role === "collaborator" ? "Registro de Chamados" : view;
}

function PageHeading({ view, profile, onRefresh }: { view: View; profile: UserProfile; onRefresh: () => void }) {
  const subtitles: Record<View, string> = {
    Dashboard: profile.role === "provider"
      ? "Acompanhe os chamados e os valores previstos do seu provedor."
      : profile.role === "collaborator"
        ? "Confira seus horários e provedores programados, além do seu status."
        : "Acompanhe a operação e os indicadores em tempo real.",
    Chamados: profile.role === "collaborator" ? "Registre um novo atendimento com os dados do cliente." : "Gerencie os atendimentos e acompanhe cada protocolo.",
    "Registro em Massa": "Registre vários protocolos de um evento de rede em um único envio.",
    PowerShell: "Copie comandos locais para diagnóstico de conectividade e portas autorizadas.",
    "Pré Fechamento": "Confira a franquia, os excedentes e os valores previstos do seu ciclo.",
    Vendas: "Converta oportunidades de pré-venda em novos clientes.",
    Provedores: "Cadastre provedores, contratos e regras de cobrança.",
    Assuntos: "Crie mensagens padrão e níveis de atendimento específicos por provedor.",
    Atuações: "Programe horários de atendimento e atribua colaboradores aos provedores.",
    Acessos: "Gerencie usuários, permissões e perfis da central.",
    Fechamento: "Confira a apuração detalhada por ciclo de faturamento.",
    "Fechamentos Anteriores": "Consulte e baixe os fechamentos arquivados dos ciclos anteriores.",
    "Métrica Financeira": "Acompanhe os resultados e compare períodos.",
  };
  return (
    <div className="page-heading">
      <div><div className="eyebrow page-eyebrow"><span className="pulse-dot" /> CENTRAL PINGDESK <span className="heading-date"><CalendarDays size={13} /> {new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date())}</span></div><h1>{displayView(view, profile.role)}</h1><p>{subtitles[view]} <span className="muted">Olá, {profile.name.split(" ")[0]}.</span></p></div>
      {profile.role !== "collaborator" && <button className="button outline refresh-button" onClick={onRefresh}><Activity size={15} /> Atualizar</button>}
    </div>
  );
}

function Dashboard({ tickets, historicalTickets, providers, users, sales, actuations, handoffAlerts, providerComments, profile, onTogglePause, pauseBusy }: { tickets: Ticket[]; historicalTickets: Ticket[]; providers: Provider[]; users: UserProfile[]; sales: Sale[]; actuations: Actuation[]; handoffAlerts: HandoffAlert[]; providerComments: ProviderComment[]; profile: UserProfile; onTogglePause: () => Promise<void>; pauseBusy: boolean }) {
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const monthTickets = historicalTickets.filter((ticket) => (ticket.createdAt?.toDate() ?? new Date(0)) >= monthStart);
  const isAdmin = profile.role === "admin";
  if (profile.role === "provider") {
    const provider = providers.find((item) => item.id === profile.providerId);
    return provider
      ? <ProviderDashboard provider={provider} tickets={tickets} historyTickets={historicalTickets} sales={sales} />
      : <EmptyState icon={Building2} title="Provedor não encontrado" text="Esta conta não está vinculada a um provedor disponível." />;
  }
  if (profile.role === "collaborator") {
    return <CollaboratorDashboard profile={profile} actuations={actuations} handoffAlerts={handoffAlerts} onTogglePause={onTogglePause} pauseBusy={pauseBusy} />;
  }
  const now = new Date();
  const recentMonths = Array.from({ length: 6 }, (_, index) => {
    const start = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
  });
  const chartData = providers.map((provider) => {
    const rows = historicalTickets.filter((ticket) => ticket.providerId === provider.id && ticket.createdAt);
    const averageFor = (level: TicketLevel) => {
      const count = recentMonths.reduce((total, month) => total + rows.filter((ticket) => {
        const createdAt = ticket.createdAt!.toDate();
        return ticket.level === level && createdAt >= month.start && createdAt < month.end;
      }).length, 0);
      return Math.round((count / recentMonths.length) * 10) / 10;
    };
    return {
      provider: provider.name.length > 14 ? `${provider.name.slice(0, 14)}…` : provider.name,
      N1: averageFor("N1"),
      N2: averageFor("N2"),
      Massivo: averageFor("Massivo"),
      "Pré Venda": averageFor("Pré Venda"),
    };
  });
  const isPresenceOnline = (item: UserProfile) => Boolean(item.isOnline && item.lastSeenAt && Date.now() - item.lastSeenAt.toDate().getTime() < 120_000);
  const onlineUsers = users.filter(isPresenceOnline);
  const teamRoster = users
    .filter((item) => item.role === "collaborator")
    .sort((a, b) => Number(isPresenceOnline(b)) - Number(isPresenceOnline(a)) || a.name.localeCompare(b.name, "pt-BR"));
  const estimates = providers.map((provider) => {
    const report = calculateClosing(provider, tickets, sales);
    return report.total;
  }).reduce((sum, value) => sum + value, 0);
  return (
    <>
      <div className="metric-grid">
        <MetricCard label="Chamados no mês" value={monthTickets.length.toLocaleString("pt-BR")} change="Atendimentos registrados" icon={Headset} tone="cyan" />
        <MetricCard label="Provedores ativos" value={providers.length.toLocaleString("pt-BR")} change="Com operação cadastrada" icon={Building2} tone="violet" />
        <MetricCard label="Pré-vendas abertas" value={monthTickets.filter((ticket) => ticket.level === "Pré Venda" && !sales.some((sale) => sale.ticketId === ticket.id)).length.toLocaleString("pt-BR")} change="Oportunidades em andamento" icon={ArrowUpRight} tone="amber" />
        <MetricCard label={isAdmin ? "Fechamento estimado" : "Chamados da operação"} value={isAdmin ? currency(estimates) : monthTickets.length.toLocaleString("pt-BR")} change={isAdmin ? "Estimativa do ciclo atual" : "Este mês"} icon={BadgeDollarSign} tone="green" />
      </div>
      <div className="dashboard-grid">
        <section className="panel chart-panel"><div className="panel-heading"><div><h2>Média de chamados por provedor</h2><p>Média mensal por nível · últimos 6 meses</p></div><span className="panel-period"><CalendarDays size={14} /> 6 meses</span></div>
          {chartData.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} barGap={4}><CartesianGrid stroke="#1b2b3a" vertical={false} /><XAxis dataKey="provider" stroke="#71839a" tickLine={false} axisLine={false} fontSize={11} /><YAxis stroke="#71839a" tickLine={false} axisLine={false} fontSize={11} /><Tooltip contentStyle={{ background: "#0d1824", border: "1px solid #203448", borderRadius: 12, color: "#eaf3fc" }} /><Bar dataKey="N1" fill="#22c8e8" radius={[4, 4, 0, 0]} /><Bar dataKey="N2" fill="#667cff" radius={[4, 4, 0, 0]} /><Bar dataKey="Massivo" fill="#ffb84d" radius={[4, 4, 0, 0]} /><Bar dataKey="Pré Venda" fill="#32d296" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div> : <EmptyState icon={BarChart3} title="Sem dados para exibir" text="Os chamados aparecerão neste gráfico quando forem registrados." />}
          <div className="chart-legend"><span><i className="legend-cyan" /> N1</span><span><i className="legend-violet" /> N2</span><span><i className="legend-amber" /> Massivo</span><span><i className="legend-green" /> Pré Venda</span></div>
        </section>
        <section className="panel online-panel"><div className="panel-heading"><div><h2>Equipe online</h2><p>Presença atualizada a cada minuto</p></div><span className="online-count"><i /> {onlineUsers.length} online</span></div>
          {teamRoster.length ? <div className="online-list">{teamRoster.map((item) => { const online = isPresenceOnline(item); return <div className="online-row" key={item.uid}><div className="avatar">{initials(item.name)}</div><div className="online-user"><b>{item.name}</b><small>{online && item.isPaused ? "Em pausa" : ROLE_LABELS[item.role]}</small></div><span className={`online-time ${online ? "" : "offline-time"}`}><i /> {online ? "Online há" : "Offline há"} {elapsed(online ? item.onlineSince?.toDate() : item.lastSeenAt?.toDate())}</span></div>; })}</div> : <EmptyState icon={Users} title="Sem colaboradores cadastrados" text="Os colaboradores e seus tempos de presença aparecerão aqui." />}
          <div className="online-summary"><div><span>Colaboradores online</span><b>{onlineUsers.filter((item) => item.role === "collaborator").length} ativos</b></div><div><span>Offline</span><b>{Math.max(0, users.filter((item) => item.role === "collaborator").length - onlineUsers.filter((item) => item.role === "collaborator").length)} colaboradores</b></div></div>
        </section>
      </div>
      <section className="panel recent-panel"><div className="panel-heading"><div><h2>Chamados recentes</h2><p>Últimos registros da central</p></div><span className="record-count">{tickets.length} registros</span></div>
        <TicketTable tickets={ticketsNewestFirst(tickets).slice(0, 5)} providers={providers} compact />
      </section>
      <section className="panel recent-panel"><div className="panel-heading"><div><h2>Comentários dos provedores</h2><p>Atualizações recebidas nos chamados</p></div><span className="record-count">{providerComments.length} comentários</span></div>
        {providerComments.length ? <div className="provider-comment-list">{providerComments.slice(0, 10).map((item) => <article className="provider-comment-item" key={item.id}><span className="metric-icon cyan"><MessageSquareText size={17} /></span><div className="provider-comment-content"><b>Provedor {item.providerName} incluiu comentário no protocolo {item.protocol}</b><p>{item.comment}</p><small>{dateLabel(item.createdAt?.toDate())}</small></div></article>)}</div> : <EmptyState icon={MessageSquareText} title="Nenhum comentário recebido" text="Os comentários adicionados pelos provedores aparecerão aqui." />}
      </section>
    </>
  );
}

function CollaboratorDashboard({ profile, actuations, handoffAlerts, onTogglePause, pauseBusy }: { profile: UserProfile; actuations: Actuation[]; handoffAlerts: HandoffAlert[]; onTogglePause: () => Promise<void>; pauseBusy: boolean }) {
  const agendaRows = [{ id: profile.uid, name: profile.name }];
  return (
    <>
      <section className={`collaborator-status collaborator-dashboard ${profile.isPaused ? "is-paused" : ""}`}>
        <div className="status-indicator"><i /><span>{profile.isPaused ? "Você está em pausa" : "Você está ativo"}</span><small>{profile.isPaused ? "Seus colegas foram avisados. Retome quando estiver disponível." : "Você está disponível para registrar e acompanhar chamados."}</small></div>
        <button className={`button ${profile.isPaused ? "primary" : "outline"} status-toggle`} disabled={pauseBusy} onClick={() => void onTogglePause()}>{profile.isPaused ? <><Play size={15} /> Voltar à atividade</> : <><Pause size={15} /> Entrar em pausa</>}</button>
      </section>
      {handoffAlerts.length > 0 && <section className="handoff-alert-panel" role="alert">
        <div className="handoff-alert-heading"><Clock3 size={18} /><div><b>Encerramento próximo</b><span>Confira a troca de responsável pelos provedores.</span></div></div>
        <div className="handoff-alert-list">{handoffAlerts.map((alert) => <article className="handoff-alert-item" key={alert.id}>
          <div><b>{alert.providerName}</b><small>Sua atuação termina às {alert.endTime} · faltam {alert.remainingMinutes} min</small></div>
          <div className="handoff-next-person"><span>Próximo responsável</span><b>{alert.nextCollaboratorName ?? "Nenhum colaborador agendado nos próximos 60 dias"}</b>{alert.nextStartTime && alert.nextServiceDate && <small>{alert.nextServiceDate === localDateString(new Date()) ? "Hoje" : dateOnly(new Date(`${alert.nextServiceDate}T12:00:00`))} às {alert.nextStartTime}</small>}</div>
        </article>)}</div>
      </section>}
      <section className="panel table-panel collaborator-actuations"><div className="panel-heading"><div><h2>Sua agenda de hoje</h2><p>Provedores e horários programados para você</p></div><span className="panel-period"><CalendarDays size={14} /> {dateOnly(new Date())}</span></div>
        {actuations.length
          ? <ScheduleAgenda rows={agendaRows} actuations={actuations} />
          : <EmptyState icon={CalendarClock} title="Nenhuma atuação programada" text="Quando houver um turno atribuído a você, o provedor e o horário aparecerão na agenda." />}
      </section>
    </>
  );
}

function ProviderDashboard({ provider, tickets, historyTickets, sales }: { provider: Provider; tickets: Ticket[]; historyTickets: Ticket[]; sales: Sale[] }) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthTickets = historyTickets.filter((ticket) => {
    const openedAt = ticketOpenedAt(ticket);
    return openedAt && openedAt >= monthStart && openedAt <= now;
  });
  const recentMonths = Array.from({ length: 6 }, (_, index) => {
    const start = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
  });
  const chartData = TICKET_LEVELS.map((level) => {
    const total = recentMonths.reduce((sum, period) => sum + historyTickets.filter((ticket) => {
      const openedAt = ticketOpenedAt(ticket);
      return ticket.level === level && openedAt && openedAt >= period.start && openedAt < period.end;
    }).length, 0);
    return { level, average: Math.round((total / recentMonths.length) * 10) / 10 };
  });
  const report = calculateClosing(provider, tickets, sales);
  return <>
    <div className="metric-grid">
      <MetricCard label="Chamados no mês" value={monthTickets.length.toLocaleString("pt-BR")} change="Atendimentos abertos neste mês" icon={Headset} tone="cyan" />
      <MetricCard label="Franquia utilizada" value={`${report.includedUsed} / ${report.includedLimit}`} change="Chamados N1, N2 e Pré Venda no ciclo" icon={Building2} tone="violet" />
      <MetricCard label="Valor previsto a receber" value={currency(report.total)} change={`Ciclo ${dateOnly(report.start)} — ${dateOnly(report.end)}`} icon={BadgeDollarSign} tone="green" />
    </div>
    <section className="panel chart-panel provider-chart"><div className="panel-heading"><div><h2>Média de chamados por nível</h2><p>{provider.name} · média mensal dos últimos 6 meses</p></div><span className="panel-period"><CalendarDays size={14} /> 6 meses</span></div>
      <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData}><CartesianGrid stroke="#1b2b3a" vertical={false} /><XAxis dataKey="level" stroke="#71839a" tickLine={false} axisLine={false} fontSize={11} /><YAxis stroke="#71839a" tickLine={false} axisLine={false} fontSize={11} allowDecimals={false} /><Tooltip contentStyle={{ background: "#0d1824", border: "1px solid #203448", borderRadius: 12, color: "#eaf3fc" }} /><Bar dataKey="average" name="Média mensal" fill="#22c8e8" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>
    </section>
    <section className="panel recent-panel"><div className="panel-heading"><div><h2>Chamados recentes</h2><p>Últimos registros do seu provedor</p></div><span className="record-count">{tickets.length} registros</span></div><TicketTable tickets={ticketsNewestFirst(tickets).slice(0, 5)} providers={[provider]} showProvider={false} /></section>
  </>;
}

function MetricCard({ label, value, change, icon: Icon, tone }: { label: string; value: string; change: string; icon: typeof Headset; tone: string }) {
  return <section className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={19} /></div><span className="metric-label">{label}</span><b className="metric-value">{value}</b><span className="metric-change"><i /> {change}</span></section>;
}

function Calls({ tickets, subjects, providers, users, profile, demoMode, onDemoCreate, onAddComment, onReload, setNotice }: { tickets: Ticket[]; subjects: TicketSubject[]; providers: Provider[]; users: UserProfile[]; profile: UserProfile; demoMode: boolean; onDemoCreate: (ticket: Ticket) => void; onAddComment: (ticket: Ticket, comment: string) => Promise<void>; onReload: () => Promise<void>; setNotice: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [collaboratorFilter, setCollaboratorFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [editing, setEditing] = useState<Ticket | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Ticket | null>(null);
  const [commenting, setCommenting] = useState<Ticket | null>(null);
  const shown = ticketsNewestFirst(tickets.filter((ticket) => {
    const q = search.toLocaleLowerCase("pt-BR");
    const matchesText = !q || [ticket.protocol, ticket.contact, ticket.customer, ticket.subjectName, ticket.description].some((value) => value?.toLocaleLowerCase("pt-BR").includes(q));
    return matchesText && (!providerFilter || ticket.providerId === providerFilter) && (!collaboratorFilter || ticket.collaboratorId === collaboratorFilter) && (!levelFilter || ticket.level === levelFilter);
  }));
  const canEdit = profile.role === "admin";
  const isProvider = profile.role === "provider";
  if (profile.role === "collaborator") {
    return <>
      <TicketDialog ticket={null} subjects={subjects} providers={providers} profile={profile} demoMode={demoMode} inline onDemoCreate={onDemoCreate} onClose={() => undefined} onSaved={onReload} setNotice={setNotice} />
    </>;
  }
  return (
    <>
      <section className="panel filters-panel"><div className="filter-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por protocolo, contato ou palavra-chave..." /></div>
        {!isProvider && <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="">Todos os provedores</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>}
        {profile.role === "admin" && <select value={collaboratorFilter} onChange={(event) => setCollaboratorFilter(event.target.value)}><option value="">Todos os colaboradores</option>{users.filter((item) => item.role === "collaborator").map((item) => <option key={item.uid} value={item.uid}>{item.name}</option>)}</select>}
        <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)}><option value="">Todos os níveis</option>{TICKET_LEVELS.map((level) => <option key={level}>{level}</option>)}</select>
        <button className="button outline" onClick={() => exportTickets(shown, providers, isProvider ? providers[0]?.name : undefined, canEdit)}><ArrowDownToLine size={16} /> Exportar Excel</button>
      </section>
      <section className="panel table-panel"><div className="panel-heading"><div><h2>Lista de chamados</h2><p>{shown.length} chamados encontrados</p></div>{profile.role !== "provider" && <button className="button primary" onClick={() => setCreating(true)}><Plus size={16} /> Novo chamado</button>}</div>
        <TicketTable tickets={shown} providers={providers} showProvider={!isProvider} emptyText={isProvider ? "Os chamados vinculados ao seu provedor aparecerão aqui." : undefined} actions={(ticket) => canEdit ? <><button className="icon-button row-action" aria-label="Editar chamado" onClick={() => setEditing(ticket)}><Pencil size={15} /></button><button className="icon-button row-action danger-action" aria-label="Excluir chamado" onClick={() => setConfirmDelete(ticket)}><Trash2 size={15} /></button></> : isProvider ? <button className="icon-button row-action" aria-label={`Incluir comentário no protocolo ${ticket.protocol}`} title="Incluir comentário" onClick={() => setCommenting(ticket)}><MessageSquarePlus size={15} /></button> : null} />
      </section>
      {(creating || editing) && <TicketDialog ticket={editing} subjects={subjects} providers={providers} profile={profile} demoMode={demoMode} onDemoCreate={onDemoCreate} onClose={() => { setCreating(false); setEditing(null); }} onSaved={async () => { setCreating(false); setEditing(null); await onReload(); }} setNotice={setNotice} />}
      {commenting && <ProviderCommentDialog ticket={commenting} onClose={() => setCommenting(null)} onSave={onAddComment} />}
      {confirmDelete && <ConfirmDialog title="Excluir chamado?" text={`O protocolo ${confirmDelete.protocol} será removido permanentemente.`} onCancel={() => setConfirmDelete(null)} onConfirm={async () => { try { await deleteDoc(doc(db!, "tickets", confirmDelete.id)); setNotice("Chamado excluído."); setConfirmDelete(null); await onReload(); } catch (error) { setNotice(`Erro ao excluir chamado: ${firebaseError(error)}`); } }} />}
    </>
  );
}

function MassTicketRegistration({ providers, profile, demoMode, onDemoCreate, onReload, setNotice }: { providers: Provider[]; profile: UserProfile; demoMode: boolean; onDemoCreate: (ticket: Ticket) => void; onReload: () => Promise<void>; setNotice: (value: string) => void }) {
  const maxProtocols = 500;
  const [providerId, setProviderId] = useState("");
  const [protocols, setProtocols] = useState([""]);
  const [saving, setSaving] = useState(false);
  const filledProtocols = protocols.map((protocol) => protocol.trim()).filter(Boolean);
  const hasIntermediateBlank = protocols.slice(0, -1).some((protocol) => !protocol.trim());
  const canSave = Boolean(providerId && filledProtocols.length && !hasIntermediateBlank && filledProtocols.length <= maxProtocols && !saving);

  function updateProtocol(index: number, value: string) {
    setProtocols((current) => {
      const next = [...current];
      next[index] = value;
      if (value.trim() && index === current.length - 1 && current.length < maxProtocols) next.push("");
      return next;
    });
  }

  function removeProtocol(index: number) {
    setProtocols((current) => current.length === 1
      ? [""]
      : current.filter((_, currentIndex) => currentIndex !== index));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!providerId) {
      setNotice("Selecione o provedor para registrar os protocolos.");
      return;
    }
    if (!filledProtocols.length || hasIntermediateBlank) {
      setNotice("Preencha todos os protocolos ou remova as caixas vazias antes de salvar.");
      return;
    }
    if (filledProtocols.length > maxProtocols) {
      setNotice(`É possível salvar até ${maxProtocols} protocolos por envio.`);
      return;
    }

    setSaving(true);
    try {
      const openedAt = new Date();
      if (!db && demoMode) {
        filledProtocols.forEach((protocol, index) => {
          onDemoCreate({
            id: `demo-mass-ticket-${openedAt.getTime()}-${index}`,
            providerId,
            subjectName: "EVENTO NA REDE",
            collaboratorId: profile.uid,
            collaboratorName: profile.name,
            protocol,
            contact: "",
            customer: "",
            address: "",
            level: "Massivo",
            description: "EVENTO NA REDE",
            clientCreatedAt: { toDate: () => openedAt },
            createdAt: { toDate: () => openedAt },
          });
        });
      } else {
        if (!db) throw new Error("Firebase não está configurado. Não foi possível salvar os protocolos.");
        const batch = writeBatch(db);
        for (const protocol of filledProtocols) {
          const ticketRef = doc(collection(db, "tickets"));
          batch.set(ticketRef, {
            providerId,
            subjectName: "EVENTO NA REDE",
            collaboratorId: profile.uid,
            collaboratorName: profile.name,
            protocol,
            contact: "",
            customer: "",
            address: "",
            level: "Massivo",
            description: "EVENTO NA REDE",
            clientCreatedAt: Timestamp.fromDate(openedAt),
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
      setProtocols([""]);
      setNotice(`${filledProtocols.length} ${filledProtocols.length === 1 ? "protocolo registrado" : "protocolos registrados"} com o assunto EVENTO NA REDE.`);
      await onReload();
    } catch (error) {
      setNotice(`Erro ao salvar os protocolos: ${firebaseError(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return <section className="panel table-panel mass-registration-panel">
    <div className="panel-heading"><div><h2>Registro em Massa</h2><p>Informe vários protocolos do mesmo evento de rede. Cada protocolo será salvo como um chamado.</p></div><span className="record-count">{filledProtocols.length} / {maxProtocols}</span></div>
    <form className="mass-registration-form" onSubmit={submit}>
      <label className="mass-provider-field">Provedor<select required value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">Selecione um provedor</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
      <div className="mass-subject-field"><span>Assunto e descrição</span><div className="mass-subject-value">EVENTO NA REDE</div><small>Nível do atendimento: Massivo.</small></div>
      {!providers.length && <div className="notice error-notice mass-form-message">Nenhum provedor cadastrado está disponível.</div>}
      <div className="mass-protocols">
        <div className="mass-protocol-heading"><b>Protocolos</b><span>Uma nova caixa aparece ao preencher a última.</span></div>
        {protocols.map((protocol, index) => (
          <div className="mass-protocol-row" key={index}>
            <label><span>Protocolo {index + 1}</span><input value={protocol} maxLength={200} aria-label={`Protocolo ${index + 1}`} placeholder="Digite o protocolo" onChange={(event) => updateProtocol(index, event.target.value)} /></label>
            {protocols.length > 1 && <button type="button" className="icon-button row-action danger-action" aria-label={`Remover protocolo ${index + 1}`} onClick={() => removeProtocol(index)}><X size={15} /></button>}
          </div>
        ))}
        {hasIntermediateBlank && <div className="notice error-notice mass-form-message">Preencha ou remova as caixas de protocolo vazias antes de salvar.</div>}
      </div>
      <div className="mass-registration-footer"><small>Até {maxProtocols} protocolos por envio.</small><button className="button primary" disabled={!canSave}>{saving ? "Salvando..." : `Salvar ${filledProtocols.length || ""} chamado${filledProtocols.length === 1 ? "" : "s"}`}</button></div>
    </form>
  </section>;
}

function PowerShellTools({ providers }: { providers: Provider[] }) {
  const authorizedTargets = providers.flatMap((provider) =>
    Array.from(new Set((provider.diagnosticIps ?? []).map((ipAddress) => ipAddress.trim()).filter(isValidIpv4)))
      .map((ipAddress) => ({ providerId: provider.id, providerName: provider.name, ipAddress })),
  );
  const [targetKey, setTargetKey] = useState("");
  const [copiedCommand, setCopiedCommand] = useState("");
  const [copyError, setCopyError] = useState("");
  const selectedTarget = authorizedTargets.find((target) => `${target.providerId}:${target.ipAddress}` === targetKey);
  const ipAddress = selectedTarget?.ipAddress;
  const validIp = Boolean(ipAddress && isValidIpv4(ipAddress));
  const ports = [80, 443, 8080, 8081, 8082, 8085, 8086, 8090];
  const batchCommand = ipAddress
    ? `$ip = "${ipAddress}"\n$portas = ${ports.join(",")}\n\nforeach ($porta in $portas) {\n    $resultado = Test-NetConnection $ip -Port $porta -WarningAction SilentlyContinue\n    [PSCustomObject]@{\n        IP        = $ip\n        Porta     = $porta\n        Resultado = if ($resultado.TcpTestSucceeded) { "ABERTA" } else { "FECHADA/BLOQUEADA" }\n    }\n}`
    : "";
  const address = validIp ? ipAddress ?? "<IP>" : "<IP>";
  const commands = [
    { id: "ping", title: "Testar conectividade (Ping)", description: "Envia quatro solicitações ICMP para verificar se o endereço responde.", command: `Test-Connection -ComputerName "${address}" -Count 4`, enabled: validIp },
    { id: "tracert", title: "Verificar rota (Tracert)", description: "Mostra os saltos da rota até o endereço, sem resolução de nomes em cada salto.", command: `tracert.exe -d "${address}"`, enabled: validIp },
    { id: "ports", title: "Testar as 8 portas TCP usadas pela equipe", description: `Testa em sequência as portas ${ports.join(", ")} no endereço autorizado selecionado.`, command: batchCommand || "Selecione um destino autorizado para gerar o comando.", enabled: validIp },
  ];

  async function copyCommand(id: string, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(id);
      setCopyError("");
      window.setTimeout(() => setCopiedCommand((current) => current === id ? "" : current), 2500);
    } catch (error) {
      setCopyError(`Não foi possível copiar o comando: ${firebaseError(error)}`);
    }
  }

  return <section className="panel powershell-panel">
    <div className="panel-heading"><div><h2>Diagnóstico de rede no PowerShell</h2><p>Monte um comando para copiar e executar no PowerShell do seu computador.</p></div><span className="panel-period"><Terminal size={14} /> Ferramentas locais</span></div>
    <div className="notice warning-notice powershell-safety"><ShieldCheck size={16} /><span>Os testes ficam limitados aos IPs autorizados cadastrados pelo administrador nos provedores. Os comandos não são executados pela Central: são copiados para execução local.</span></div>
    <div className="powershell-target-fields">
      <label className="powershell-target-select">Destino autorizado<select value={targetKey} onChange={(event) => setTargetKey(event.target.value)}><option value="">Selecione provedor e IP</option>{authorizedTargets.map((target) => <option key={`${target.providerId}:${target.ipAddress}`} value={`${target.providerId}:${target.ipAddress}`}>{target.providerName} · {target.ipAddress}</option>)}</select><small>O administrador cadastra os endereços em Provedores → Editar.</small></label>
    </div>
    {authorizedTargets.length === 0 && <div className="notice warning-notice powershell-copy-error">Ainda não há IPs de diagnóstico autorizados cadastrados. Solicite ao administrador que os adicione ao provedor correto.</div>}
    {copyError && <div className="notice error-notice powershell-copy-error" role="alert">{copyError}</div>}
    <div className="powershell-command-list">{commands.map((item) => <article className="powershell-command-card" key={item.id}>
      <div className="powershell-command-description"><span className="powershell-command-icon"><Terminal size={16} /></span><span><b>{item.title}</b><small>{item.description}</small></span></div>
      <pre><code>{item.command}</code></pre>
      <button className="button outline" type="button" disabled={!item.enabled} onClick={() => void copyCommand(item.id, item.command)}>{copiedCommand === item.id ? <><Check size={14} /> Copiado</> : <><Copy size={14} /> Copiar comando</>}</button>
    </article>)}</div>
  </section>;
}

function ProviderCommentDialog({ ticket, onClose, onSave }: { ticket: Ticket; onClose: () => void; onSave: (ticket: Ticket, comment: string) => Promise<void> }) {
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = comment.trim();
    if (!trimmed || trimmed.length > 2000) {
      setError("Informe um comentário com até 2.000 caracteres.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(ticket, trimmed);
      onClose();
    } catch (reason) {
      setError(firebaseError(reason));
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={`Comentar protocolo ${ticket.protocol}`} onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <p className="field-span comment-ticket-summary"><b>{ticket.customer}</b><span>{ticket.subjectName ?? ticket.level}</span></p>
    <label className="field-span">Comentário<textarea required rows={5} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Escreva uma atualização sobre este chamado." /></label>
    <small className="field-span">{comment.length}/2.000 caracteres. O administrador será notificado no Dashboard.</small>
    {error && <div className="notice warning-notice field-span">{error}</div>}
    <div className="modal-actions"><button type="button" className="button outline" disabled={saving} onClick={onClose}>Cancelar</button><button className="button primary" disabled={saving || !comment.trim()}>{saving ? "Enviando..." : "Enviar comentário"}</button></div>
  </form></Modal>;
}

function TicketTable({ tickets, providers, compact = false, showProvider = true, emptyText, actions }: { tickets: Ticket[]; providers: Provider[]; compact?: boolean; showProvider?: boolean; emptyText?: string; actions?: (ticket: Ticket) => ReactNode }) {
  if (!tickets.length) return <EmptyState icon={Headset} title="Nenhum chamado encontrado" text={emptyText ?? "Ajuste os filtros ou registre um novo atendimento."} />;
  return <div className="table-scroll"><table><thead><tr><th>ABERTURA</th><th>PROTOCOLO</th><th>ASSUNTO</th><th>CONTATO / CLIENTE</th>{showProvider && <th>PROVEDOR</th>}<th>NÍVEL</th>{!compact && <><th>ENDEREÇO</th><th>DESCRIÇÃO</th></>}{actions && <th>AÇÕES</th>}</tr></thead><tbody>{tickets.map((ticket) => <tr key={ticket.id}><td className="date-cell">{dateLabel(ticketOpenedAt(ticket))}</td><td><span className="protocol">{ticket.protocol}</span></td><td>{ticket.subjectName ?? "—"}</td><td><b>{ticket.contact}</b><small className="table-subtext">{ticket.customer}</small></td>{showProvider && <td>{providers.find((provider) => provider.id === ticket.providerId)?.name ?? "—"}</td>}<td><span className={`level-pill ${levelClass(ticket.level)}`}>{ticket.level}</span></td>{!compact && <><td className="truncate-cell" title={ticket.address}>{ticket.address}</td><td className="truncate-cell" title={ticket.description}>{ticket.description}</td></>}{actions && <td><div className="row-actions">{actions(ticket)}</div></td>}</tr>)}</tbody></table></div>;
}

function TicketDialog({ ticket, subjects, providers, profile, demoMode, inline = false, onDemoCreate, onClose, onSaved, setNotice }: { ticket: Ticket | null; subjects: TicketSubject[]; providers: Provider[]; profile: UserProfile; demoMode: boolean; inline?: boolean; onDemoCreate: (ticket: Ticket) => void; onClose: () => void; onSaved: () => Promise<void>; setNotice: (value: string) => void }) {
  const [form, setForm] = useState({ ...emptyTicket, ...(ticket ?? {}), providerId: ticket?.providerId ?? (profile.role === "collaborator" ? "" : profile.providerId ?? providers[0]?.id ?? "") });
  const [saving, setSaving] = useState(false);
  const providerSubjects = subjects.filter((subject) => subjectProviderIds(subject).includes(form.providerId));
  const selectedProvider = providers.find((provider) => provider.id === form.providerId);
  const matchingProviders = providersMatchingProtocol(providers, form.protocol);
  const currentProtocolWarning = profile.role === "collaborator"
    ? selectedProvider
      ? protocolWarning(selectedProvider, form.protocol)
      : matchingProviders.length > 1
        ? "O protocolo corresponde ao padrão de mais de um provedor. Selecione manualmente o provedor correto."
        : ""
    : "";
  function updateProtocol(value: string) {
    const matches = providersMatchingProtocol(providers, value);
    setForm((current) => {
      const matchedProvider = matches.length === 1 ? matches[0] : undefined;
      if (!matchedProvider || matchedProvider.id === current.providerId) {
        return { ...current, protocol: value };
      }
      return {
        ...current,
        protocol: value,
        providerId: matchedProvider.id,
        subjectId: "",
        subjectName: "",
        level: "N1",
        description: "",
      };
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (currentProtocolWarning) {
      setNotice(currentProtocolWarning);
      return;
    }
    setSaving(true);
    try {
      const providerId = profile.role === "provider" ? profile.providerId : form.providerId;
      if (!providerId) throw new Error("Selecione um provedor para registrar o chamado.");
      if (!db && demoMode && !ticket) {
        const openedAt = new Date();
        const provider = providers.find((item) => item.id === providerId);
        if (!provider) throw new Error("O provedor selecionado não foi encontrado.");
        const subject = subjects.find((item) => item.id === form.subjectId);
        const newTicket: Ticket = {
          id: `demo-ticket-${openedAt.getTime()}`,
          providerId,
          ...(subject ? { subjectId: subject.id, subjectName: subject.name } : {}),
          collaboratorId: profile.uid,
          collaboratorName: profile.name,
          protocol: form.protocol.trim(),
          contact: form.contact.trim(),
          customer: form.customer.trim(),
          address: form.address.trim(),
          level: form.level,
          description: form.description.trim(),
          clientCreatedAt: { toDate: () => openedAt },
          createdAt: { toDate: () => openedAt },
        };
        onDemoCreate(newTicket);
        setNotice("Chamado incluído na demonstração local. Não foi salvo no Firebase nem enviado ao Telegram.");
        if (inline) setForm({ ...emptyTicket, providerId });
        await onSaved();
        return;
      }
      if (!db) throw new Error("Firebase não está configurado. Não foi possível salvar o chamado.");
      const payload = {
        providerId,
        ...(form.subjectId ? { subjectId: form.subjectId, subjectName: subjects.find((subject) => subject.id === form.subjectId)?.name ?? form.subjectName ?? "" } : {}),
        collaboratorId: ticket?.collaboratorId ?? profile.uid,
        collaboratorName: ticket?.collaboratorName ?? profile.name,
        protocol: form.protocol.trim(),
        contact: form.contact.trim(),
        customer: form.customer.trim(),
        address: form.address.trim(),
        level: form.level,
        description: form.description.trim(),
      };
      if (ticket) await updateDoc(doc(db, "tickets", ticket.id), payload);
      else await setDoc(doc(collection(db, "tickets")), {
        ...payload,
        clientCreatedAt: Timestamp.fromDate(new Date()),
        createdAt: serverTimestamp(),
      });
      setNotice(ticket ? "Chamado atualizado." : "Chamado aberto com sucesso.");
      if (inline) setForm({ ...emptyTicket, providerId });
      await onSaved();
    } catch (error) { setNotice(`Erro ao salvar chamado: ${firebaseError(error)}`); }
    finally { setSaving(false); }
  }
  const formContent = <form className={`form-grid ${inline ? "inline-ticket-form" : ""}`} onSubmit={submit}>
    {profile.role === "admin" && <label className="field-span">Provedor<select required value={form.providerId} onChange={(event) => setForm({ ...form, providerId: event.target.value, subjectId: "", subjectName: "" })}><option value="">Selecione</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>}
    {profile.role === "collaborator" && <label className="field-span">Provedor<select required value={form.providerId} onChange={(event) => setForm({ ...form, providerId: event.target.value, subjectId: "", subjectName: "", level: "N1", description: "" })}><option value="">Selecione um provedor</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>{!providers.length ? <small>Nenhum provedor cadastrado está disponível.</small> : <small>Ao informar um protocolo compatível, o provedor será selecionado automaticamente. Também é possível selecioná-lo manualmente.</small>}</label>}
    <label className="field-span">Assunto<select required={profile.role === "collaborator"} value={form.subjectId ?? ""} onChange={(event) => { const subject = providerSubjects.find((item) => item.id === event.target.value); setForm({ ...form, subjectId: subject?.id ?? "", subjectName: subject?.name ?? "", ...(subject ? { level: subject.level, description: subject.defaultDescription } : {}) }); }}><option value="">{profile.role === "admin" ? "Sem assunto (opcional)" : "Selecione um assunto do provedor"}</option>{providerSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name} · {subject.level}</option>)}</select>{providerSubjects.length === 0 && profile.role === "collaborator" && <small>Este provedor ainda não tem assuntos cadastrados. Solicite ao administrador o cadastro antes de abrir o chamado.</small>}</label>
    {!ticket && <label>Data e hora da abertura<input type="datetime-local" required readOnly value={localDateTimeValue(new Date())} /></label>}
    <label>Protocolo<input required aria-invalid={Boolean(currentProtocolWarning)} value={form.protocol} onChange={(event) => updateProtocol(event.target.value)} /></label>
    <label>Nível<select required value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value as TicketLevel })}>{TICKET_LEVELS.map((level) => <option key={level}>{level}</option>)}</select></label>
    <label>Contato<input required value={form.contact} onChange={(event) => setForm({ ...form, contact: event.target.value })} /></label>
    <label>Cliente<input required value={form.customer} onChange={(event) => setForm({ ...form, customer: event.target.value })} /></label>
    <label className="field-span">Endereço<input required value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
    <label className="field-span">Descrição<textarea required rows={inline ? 10 : 3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
    {currentProtocolWarning && <div className="notice error-notice field-span protocol-warning" role="alert">{currentProtocolWarning}</div>}
    <div className="modal-actions">{!inline && <button type="button" className="button outline" onClick={onClose}>Cancelar</button>}<button className="button primary" disabled={saving || Boolean(currentProtocolWarning)}>{saving ? "Salvando..." : "Salvar chamado"}</button></div>
  </form>;
  if (inline) return <section className="panel table-panel inline-registration-panel"><div className="panel-heading"><div><h2>Registrar chamado</h2><p>Preencha os dados do atendimento. A descrição pode ser complementada antes de salvar.</p></div></div>{formContent}</section>;
  return <Modal title={ticket ? "Editar chamado" : "Novo chamado"} onClose={onClose}>{formContent}</Modal>;
}

function Subjects({ subjects, providers, demoMode, onDemoChange, onReload, setNotice }: { subjects: TicketSubject[]; providers: Provider[]; demoMode: boolean; onDemoChange: (subjects: TicketSubject[]) => void; onReload: () => Promise<void>; setNotice: (value: string) => void }) {
  const [providerFilter, setProviderFilter] = useState("");
  const [editing, setEditing] = useState<TicketSubject | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TicketSubject | null>(null);
  const shown = subjects
    .filter((subject) => !providerFilter || subjectProviderIds(subject).includes(providerFilter))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return <>
    <section className="panel filters-panel"><div className="filter-search"><MessageSquareText size={17} /><span>Assuntos personalizados para cada provedor</span></div><select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="">Todos os provedores</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><button className="button primary" disabled={!providers.length} onClick={() => setCreating(true)}><Plus size={16} /> Novo assunto</button></section>
    <section className="panel table-panel"><div className="panel-heading"><div><h2>Assuntos cadastrados</h2><p>{shown.length} assuntos · cada assunto oferece uma descrição inicial e um nível de atendimento</p></div></div>
      {shown.length ? <div className="table-scroll"><table><thead><tr><th>ASSUNTO</th><th>PROVEDORES</th><th>NÍVEL PADRÃO</th><th>MENSAGEM PADRÃO</th><th>AÇÕES</th></tr></thead><tbody>{shown.map((subject) => <tr key={subject.id}><td><b>{subject.name}</b></td><td>{subjectProviderIds(subject).map((id) => providers.find((provider) => provider.id === id)?.name ?? "Provedor removido").join(", ")}</td><td><span className={`level-pill ${levelClass(subject.level)}`}>{subject.level}</span></td><td className="truncate-cell" title={subject.defaultDescription}>{subject.defaultDescription}</td><td><div className="row-actions"><button className="icon-button row-action" aria-label="Editar assunto" onClick={() => setEditing(subject)}><Pencil size={15} /></button><button className="icon-button row-action danger-action" aria-label="Excluir assunto" onClick={() => setConfirmDelete(subject)}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <EmptyState icon={MessageSquareText} title="Nenhum assunto cadastrado" text="Crie assuntos por provedor para padronizar o início da descrição e o nível dos chamados." />}
    </section>
    {(creating || editing) && <SubjectDialog subject={editing} providers={providers} demoMode={demoMode} onDemoSave={(saved) => onDemoChange([...subjects.filter((item) => item.id !== saved.id), saved])} onClose={() => { setCreating(false); setEditing(null); }} onSaved={async () => { setCreating(false); setEditing(null); await onReload(); }} setNotice={setNotice} />}
    {confirmDelete && <ConfirmDialog title="Excluir assunto?" text={`O assunto "${confirmDelete.name}" deixará de aparecer em novos chamados. Chamados existentes não serão alterados.`} onCancel={() => setConfirmDelete(null)} onConfirm={async () => { try { if (demoMode) onDemoChange(subjects.filter((item) => item.id !== confirmDelete.id)); else { if (!db) throw new Error("Firestore não está configurado."); await deleteDoc(doc(db, "subjects", confirmDelete.id)); } setNotice(demoMode ? "Assunto removido apenas desta demonstração local." : "Assunto excluído."); setConfirmDelete(null); await onReload(); } catch (error) { setNotice(`Erro ao excluir assunto: ${firebaseError(error)}`); } }} />}
  </>;
}

function SubjectDialog({ subject, providers, demoMode, onDemoSave, onClose, onSaved, setNotice }: { subject: TicketSubject | null; providers: Provider[]; demoMode: boolean; onDemoSave: (subject: TicketSubject) => void; onClose: () => void; onSaved: () => Promise<void>; setNotice: (value: string) => void }) {
  const [name, setName] = useState(subject?.name ?? "");
  const [providerIds, setProviderIds] = useState(() => subject ? subjectProviderIds(subject) : providers[0] ? [providers[0].id] : []);
  const [level, setLevel] = useState<TicketLevel>(subject?.level ?? "N1");
  const [defaultDescription, setDefaultDescription] = useState(subject?.defaultDescription ?? "");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!providerIds.length) {
      setNotice("Selecione pelo menos um provedor para o assunto.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        providerIds,
        level,
        defaultDescription: defaultDescription.trim(),
      };
      if (demoMode) {
        onDemoSave({ id: subject?.id ?? `demo-subject-${Date.now()}`, ...payload, createdAt: subject?.createdAt });
        setNotice("Assunto salvo apenas nesta demonstração local; não foi gravado no Firebase.");
      } else {
        if (!db) throw new Error("Firestore não está configurado.");
        if (subject) await updateDoc(doc(db, "subjects", subject.id), { ...payload, providerId: deleteField() });
        else await setDoc(doc(collection(db, "subjects")), { ...payload, createdAt: serverTimestamp() });
        setNotice(subject ? "Assunto atualizado." : "Assunto criado.");
      }
      await onSaved();
    } catch (error) {
      setNotice(`Erro ao salvar assunto: ${firebaseError(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={subject ? "Editar assunto" : "Criar assunto"} onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <fieldset className="field-span provider-checkbox-group"><legend>Provedores vinculados</legend>{providers.map((provider) => <label className="provider-checkbox" key={provider.id}><input type="checkbox" checked={providerIds.includes(provider.id)} onChange={(event) => setProviderIds((current) => event.target.checked ? [...current, provider.id] : current.filter((id) => id !== provider.id))} /><span>{provider.name}</span></label>)}{providers.length === 0 && <small>Cadastre um provedor antes de criar assuntos.</small>}</fieldset>
    <label className="field-span">Nome do assunto<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Sem conexão, Lentidão, Mudança de plano" /></label>
    <label className="field-span">Nível padrão<select value={level} onChange={(event) => setLevel(event.target.value as TicketLevel)}>{TICKET_LEVELS.map((item) => <option key={item}>{item}</option>)}</select></label>
    <label className="field-span">Mensagem padrão<textarea required rows={4} maxLength={4000} value={defaultDescription} onChange={(event) => setDefaultDescription(event.target.value)} placeholder="Texto inicial que será preenchido na descrição do chamado." /></label>
    <div className="modal-actions"><button type="button" className="button outline" onClick={onClose}>Cancelar</button><button className="button primary" disabled={saving || !providers.length || !providerIds.length}>{saving ? "Salvando..." : "Salvar assunto"}</button></div>
  </form></Modal>;
}

function Actuations({ actuations, providers, users, demoMode, onDemoChange, onReload, setNotice }: { actuations: Actuation[]; providers: Provider[]; users: UserProfile[]; demoMode: boolean; onDemoChange: (actuations: Actuation[]) => void; onReload: () => Promise<void>; setNotice: (value: string) => void }) {
  const [dateFilter, setDateFilter] = useState(localDateString(new Date()));
  const [editing, setEditing] = useState<Actuation | null>(null);
  const [deleting, setDeleting] = useState<Actuation | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<{ providerId: string; collaboratorId: string } | null>(null);
  const shown = actuations.filter((actuation) => actuation.serviceDate === dateFilter)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const collaborators = users.filter((item) => item.role === "collaborator");
  function scheduleProvider(providerId: string, collaboratorId: string) {
    setEditing(null);
    setAssignmentDraft({ providerId, collaboratorId });
  }

  return <>
    <section className="panel actuation-planner">
      <div className="panel-heading"><div><h2>Escala de atendimento</h2><p>Arraste um provedor até o colaborador e informe o período do atendimento.</p></div><span className="record-count">{shown.length} {shown.length === 1 ? "turno" : "turnos"}</span></div>
      <div className="actuation-planner-controls"><label>Data da agenda<input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></label><button className="button primary" disabled={!providers.length || !collaborators.length} onClick={() => scheduleProvider(providers[0]?.id ?? "", collaborators[0]?.uid ?? "")}><Plus size={16} /> Nova atuação</button></div>
      <div className="provider-drag-shelf"><div className="provider-drag-heading"><b>Provedores</b><span>Arraste para a agenda de um colaborador</span></div><div className="provider-drag-list">{providers.map((provider) => <button key={provider.id} type="button" className="provider-drag-card" draggable onDragStart={(event) => { event.dataTransfer.setData("text/plain", provider.id); event.dataTransfer.effectAllowed = "copy"; }} onClick={() => scheduleProvider(provider.id, collaborators[0]?.uid ?? "")} title="Arraste até um colaborador ou clique para programar"><Building2 size={15} /><span>{provider.name}</span><Plus size={14} /></button>)}</div></div>
      {collaborators.length
        ? <ScheduleAgenda rows={collaborators.map((item) => ({ id: item.uid, name: item.name }))} actuations={shown} onProviderDrop={scheduleProvider} onEdit={setEditing} onDelete={setDeleting} />
        : <EmptyState icon={Users} title="Nenhum colaborador cadastrado" text="Cadastre um acesso de colaborador para montar a agenda de atendimento." />}
    </section>
    {(assignmentDraft || editing) && <ActuationDialog key={editing?.id ?? `${assignmentDraft?.providerId}-${assignmentDraft?.collaboratorId}`} actuation={editing} providers={providers} collaborators={collaborators} demoMode={demoMode} initialProviderId={assignmentDraft?.providerId} initialCollaboratorId={assignmentDraft?.collaboratorId} initialServiceDate={dateFilter} onClose={() => { setAssignmentDraft(null); setEditing(null); }} onSaved={async (saved) => { setAssignmentDraft(null); setEditing(null); if (demoMode) onDemoChange([...actuations.filter((item) => item.id !== saved.id), saved]); await onReload(); }} setNotice={setNotice} />}
    {deleting && <ConfirmDialog title="Excluir atuação?" text={`${deleting.collaboratorName} deixará de ver o turno de ${deleting.providerName} em ${dateOnly(new Date(`${deleting.serviceDate}T12:00:00`))}.`} onCancel={() => setDeleting(null)} onConfirm={async () => { try { if (demoMode) onDemoChange(actuations.filter((item) => item.id !== deleting.id)); else { if (!db) throw new Error("Firestore não está configurado."); await deleteDoc(doc(db, "actuations", deleting.id)); } setNotice("Atuação excluída."); setDeleting(null); await onReload(); } catch (error) { setNotice(`Erro ao excluir atuação: ${firebaseError(error)}`); } }} />}
  </>;
}

type ScheduleRow = { id: string; name: string };

function ScheduleAgenda({ rows, actuations, onProviderDrop, onEdit, onDelete }: { rows: ScheduleRow[]; actuations: Actuation[]; onProviderDrop?: (providerId: string, collaboratorId: string) => void; onEdit?: (actuation: Actuation) => void; onDelete?: (actuation: Actuation) => void }) {
  const hourHeight = 52;
  const agendaHeight = hourHeight * 24;
  const hours = Array.from({ length: 24 }, (_, hour) => hour);

  function minutes(value: string) {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>, collaboratorId: string) {
    if (!onProviderDrop) return;
    event.preventDefault();
    const providerId = event.dataTransfer.getData("text/plain");
    if (providerId) onProviderDrop(providerId, collaboratorId);
  }

  return <div className="schedule-agenda-scroll">
    <div className="schedule-agenda" style={{ minWidth: `${72 + rows.length * 230}px` }}>
      <div className="schedule-agenda-header" style={{ gridTemplateColumns: `58px repeat(${rows.length}, minmax(220px, 1fr))` }}><div className="schedule-time-heading">HORÁRIO</div>{rows.map((row) => <div className="schedule-collaborator-heading" key={row.id}><span className="avatar">{initials(row.name)}</span><b>{row.name}</b></div>)}</div>
      <div className="schedule-agenda-body" style={{ gridTemplateColumns: `58px repeat(${rows.length}, minmax(220px, 1fr))` }}>
        <div className="schedule-time-axis" style={{ height: agendaHeight }}>{hours.map((hour) => <div className="schedule-hour-label" style={{ top: hour * hourHeight }} key={hour}>{String(hour).padStart(2, "0")}:00</div>)}</div>
        {rows.map((row) => {
          const rowActuations = actuations.filter((actuation) => actuation.collaboratorId === row.id)
            .slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
          const lanes: number[] = [];
          const positions = rowActuations.map((actuation) => {
            const start = minutes(actuation.startTime);
            const end = minutes(actuation.endTime);
            let lane = lanes.findIndex((laneEnd) => laneEnd <= start);
            if (lane < 0) lane = lanes.length;
            lanes[lane] = end;
            return { actuation, start, end, lane, laneCount: 0 };
          });
          positions.forEach((position) => { position.laneCount = lanes.length; });

          return <div className={`schedule-collaborator-lane ${onProviderDrop ? "schedule-drop-target" : ""}`} key={row.id} style={{ height: agendaHeight }} onDragOver={onProviderDrop ? (event) => event.preventDefault() : undefined} onDrop={onProviderDrop ? (event) => handleDrop(event, row.id) : undefined}>
            {hours.map((hour) => <div className="schedule-hour-line" style={{ top: hour * hourHeight }} key={hour} />)}
            {rowActuations.length === 0 && onProviderDrop && <div className="schedule-drop-hint"><Plus size={16} /><span>Solte um provedor aqui</span></div>}
            {positions.map(({ actuation, start, end, lane, laneCount }) => {
              const duration = Math.max(0, end - start);
              const durationLabel = duration >= 60
                ? `${Math.floor(duration / 60)}h${duration % 60 ? ` ${duration % 60}min` : ""}`
                : `${duration}min`;
              return <article className="schedule-event" key={actuation.id} title={`${actuation.providerName} · ${actuation.startTime}–${actuation.endTime}`} style={{
                top: start / 60 * hourHeight + 2,
                height: Math.max(duration / 60 * hourHeight - 4, 34),
                left: `calc(${lane / laneCount * 100}% + 3px)`,
                width: `calc(${100 / laneCount}% - 6px)`,
              }}>
                <div className="schedule-event-title"><Building2 size={13} /><b>{actuation.providerName}</b></div>
                <span className="schedule-event-time">{actuation.startTime}–{actuation.endTime} · {durationLabel}</span>
                {(onEdit || onDelete) && <div className="schedule-event-actions">
                  {onEdit && <button className="icon-button row-action" aria-label={`Editar ${actuation.providerName}`} onClick={() => onEdit(actuation)}><Pencil size={13} /></button>}
                  {onDelete && <button className="icon-button row-action danger-action" aria-label={`Excluir ${actuation.providerName}`} onClick={() => onDelete(actuation)}><Trash2 size={13} /></button>}
                </div>}
              </article>;
            })}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

function ActuationDialog({ actuation, providers, collaborators, demoMode, initialProviderId, initialCollaboratorId, initialServiceDate, onClose, onSaved, setNotice }: { actuation: Actuation | null; providers: Provider[]; collaborators: UserProfile[]; demoMode: boolean; initialProviderId?: string; initialCollaboratorId?: string; initialServiceDate?: string; onClose: () => void; onSaved: (actuation: Actuation) => Promise<void>; setNotice: (value: string) => void }) {
  const [providerId, setProviderId] = useState(actuation?.providerId ?? initialProviderId ?? providers[0]?.id ?? "");
  const [collaboratorId, setCollaboratorId] = useState(actuation?.collaboratorId ?? initialCollaboratorId ?? collaborators[0]?.uid ?? "");
  const [serviceDate, setServiceDate] = useState(actuation?.serviceDate ?? initialServiceDate ?? localDateString(new Date()));
  const [startTime, setStartTime] = useState(actuation?.startTime ?? "08:00");
  const [endTime, setEndTime] = useState(actuation?.endTime ?? "17:00");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (endTime <= startTime) {
      setNotice("O horário de término deve ser posterior ao horário de início.");
      return;
    }
    const provider = providers.find((item) => item.id === providerId);
    const collaborator = collaborators.find((item) => item.uid === collaboratorId);
    if (!provider || !collaborator) {
      setNotice("Selecione um provedor e um colaborador válidos.");
      return;
    }
    setSaving(true);
    try {
      const saved: Actuation = {
        id: actuation?.id ?? (demoMode ? `demo-actuation-${Date.now()}` : doc(collection(db!, "actuations")).id),
        providerId,
        providerName: provider.name,
        collaboratorId,
        collaboratorName: collaborator.name,
        serviceDate,
        startTime,
        endTime,
        ...(actuation?.createdAt ? { createdAt: actuation.createdAt } : {}),
      };
      if (db) {
        const { id, ...payload } = saved;
        if (actuation) await updateDoc(doc(db, "actuations", id), { ...payload, updatedAt: serverTimestamp() });
        else await setDoc(doc(db, "actuations", id), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      } else if (!demoMode) {
        throw new Error("Firestore não está configurado.");
      }
      setNotice(actuation ? "Atuação atualizada." : "Atuação programada.");
      await onSaved(saved);
    } catch (error) {
      setNotice(`Erro ao salvar atuação: ${firebaseError(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={actuation ? "Editar atuação" : "Programar atuação"} onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <label className="field-span">Provedor<select required value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">Selecione</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
    <label className="field-span">Colaborador responsável<select required value={collaboratorId} onChange={(event) => setCollaboratorId(event.target.value)}><option value="">Selecione</option>{collaborators.map((collaborator) => <option key={collaborator.uid} value={collaborator.uid}>{collaborator.name}</option>)}</select></label>
    <label className="field-span">Data de atendimento<input required type="date" value={serviceDate} onChange={(event) => setServiceDate(event.target.value)} /></label>
    <label>Horário de início<input required type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
    <label>Horário de término<input required type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label>
    <div className="modal-actions"><button type="button" className="button outline" onClick={onClose}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? "Salvando..." : "Salvar atuação"}</button></div>
  </form></Modal>;
}

function Providers({ providers, onReload, setNotice, onCreateAccess }: { providers: Provider[]; onReload: () => Promise<void>; setNotice: (value: string) => void; onCreateAccess: (provider: Provider) => void }) {
  const [editing, setEditing] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Provider | null>(null);
  return <>
    <section className="panel table-panel"><div className="panel-heading"><div><h2>Provedores cadastrados</h2><p>Franquias, valores e ciclos de contabilização</p></div><button className="button primary" onClick={() => setCreating(true)}><Plus size={16} /> Novo provedor</button></div>
      {providers.length ? <div className="table-scroll"><table><thead><tr><th>PROVEDOR</th><th>CNPJ</th><th>FRANQUIA</th><th>VALOR FIXO</th><th>CICLO</th><th>IPS DE DIAGNÓSTICO</th><th>AÇÕES</th></tr></thead><tbody>{providers.map((provider) => <tr key={provider.id}><td><b>{provider.name}</b></td><td>{provider.cnpj || "—"}</td><td>{provider.includedCalls} chamados</td><td>{currency(provider.fixedMonthly)}</td><td>Dia {provider.billingStartDay} a {provider.billingEndDay || "último"}</td><td className="truncate-cell" title={provider.diagnosticIps?.join(", ")}>{provider.diagnosticIps?.length ? provider.diagnosticIps.join(", ") : "—"}</td><td><div className="row-actions"><button className="icon-button row-action" onClick={() => onCreateAccess(provider)} title="Criar acesso do provedor"><Users size={15} /></button><button className="icon-button row-action" onClick={() => setEditing(provider)} title="Editar"><Pencil size={15} /></button><button className="icon-button row-action danger-action" onClick={() => setConfirmDelete(provider)} title="Excluir"><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <EmptyState icon={Building2} title="Nenhum provedor cadastrado" text="Cadastre provedores para começar a registrar chamados e fechamentos." />}
    </section>
    {(creating || editing) && <ProviderDialog provider={editing} onClose={() => { setCreating(false); setEditing(null); }} onSaved={async () => { setCreating(false); setEditing(null); await onReload(); }} setNotice={setNotice} />}
    {confirmDelete && <ConfirmDialog title="Excluir provedor?" text={`O cadastro de ${confirmDelete.name} será removido. Chamados existentes não serão apagados.`} onCancel={() => setConfirmDelete(null)} onConfirm={async () => { try { await deleteDoc(doc(db!, "providers", confirmDelete.id)); setNotice("Provedor excluído."); setConfirmDelete(null); await onReload(); } catch (error) { setNotice(`Erro ao excluir provedor: ${firebaseError(error)}`); } }} />}
  </>;
}

function ProviderDialog({ provider, onClose, onSaved, setNotice }: { provider: Provider | null; onClose: () => void; onSaved: () => Promise<void>; setNotice: (value: string) => void }) {
  const [form, setForm] = useState({ ...emptyProvider, ...(provider ? {
    name: provider.name, cnpj: provider.cnpj, includedCalls: provider.includedCalls, fixedMonthly: provider.fixedMonthly,
    n1: provider.rates?.N1 ?? 0, n2: provider.rates?.N2 ?? 0, preSale: provider.rates?.["Pré Venda"] ?? 0, massive: provider.rates?.Massivo ?? 0,
    billingStartDay: provider.billingStartDay, billingEndDay: provider.billingEndDay, protocolPattern: provider.protocolPattern ?? "",
    diagnosticIpsText: (provider.diagnosticIps ?? []).join("\n"),
  } : {}) });
  const [saving, setSaving] = useState(false);
  function numberField(key: "includedCalls" | "fixedMonthly" | "n1" | "n2" | "preSale" | "massive", label: string) {
    const step = key === "includedCalls" ? "1" : "0.01";
    return <label>{label}<input type="number" min="0" step={step} value={form[key]} onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })} /></label>;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!db) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(), cnpj: form.cnpj.trim(), includedCalls: Number(form.includedCalls), fixedMonthly: Number(form.fixedMonthly),
        rates: { N1: Number(form.n1), N2: Number(form.n2), "Pré Venda": Number(form.preSale), Massivo: Number(form.massive) },
        billingStartDay: Number(form.billingStartDay), billingEndDay: Number(form.billingEndDay), protocolPattern: form.protocolPattern.trim(),
        diagnosticIps: Array.from(new Set(form.diagnosticIpsText.split(/[\s,;]+/).map((ip) => ip.trim()).filter(Boolean))),
      };
      if (payload.diagnosticIps.length > 20 || payload.diagnosticIps.some((ip) => !isValidIpv4(ip))) {
        setNotice("Informe até 20 endereços IPv4 válidos, um por linha.");
        setSaving(false);
        return;
      }
      if (provider) await updateDoc(doc(db, "providers", provider.id), payload);
      else await setDoc(doc(collection(db, "providers")), { ...payload, createdAt: serverTimestamp() });
      setNotice(provider ? "Cadastro do provedor atualizado." : "Provedor cadastrado.");
      await onSaved();
    } catch (error) { setNotice(`Erro ao salvar provedor: ${firebaseError(error)}`); }
    finally { setSaving(false); }
  }
  return <Modal title={provider ? "Editar provedor" : "Cadastrar provedor"} onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <label className="field-span">Nome do provedor<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
    <label>CNPJ<input value={form.cnpj} onChange={(event) => setForm({ ...form, cnpj: event.target.value })} /></label>
    {numberField("includedCalls", "Franquia de chamados")}
    {numberField("fixedMonthly", "Valor fixo mensal (R$)")}
    {numberField("n1", "Atendimento N1 excedente (R$)")}
    {numberField("n2", "Atendimento N2 excedente (R$)")}
    {numberField("preSale", "Pré-venda excedente (R$)")}
    {numberField("massive", "Atendimento massivo (R$)")}
    <label>Início do ciclo (dia)<input type="number" min="1" max="31" value={form.billingStartDay} onChange={(event) => setForm({ ...form, billingStartDay: Number(event.target.value) })} /></label>
    <label>Fim do ciclo (dia)<input type="number" min="0" max="31" value={form.billingEndDay} onChange={(event) => setForm({ ...form, billingEndDay: Number(event.target.value) })} /><small>Informe 0 para usar o último dia do mês.</small></label>
    <label className="field-span">Padrão de protocolo (expressão regular)<input value={form.protocolPattern} onChange={(event) => setForm({ ...form, protocolPattern: event.target.value })} placeholder="Ex.: ^ABC-\\d{6}$" /><small>Opcional. Usado no fechamento para sinalizar protocolos fora do padrão.</small></label>
    <label className="field-span">IPs autorizados para diagnóstico<textarea rows={4} maxLength={4000} value={form.diagnosticIpsText} onChange={(event) => setForm({ ...form, diagnosticIpsText: event.target.value })} placeholder={"Um endereço IPv4 por linha\nEx.: 100.100.70.217"} /><small>Somente colaboradores poderão testar portas nos endereços cadastrados aqui. Até 20 IPv4 por provedor.</small></label>
    <div className="modal-actions"><button type="button" className="button outline" onClick={onClose}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? "Salvando..." : "Salvar provedor"}</button></div>
  </form></Modal>;
}

function Sales({ tickets, providers, sales, onReload, setNotice }: { tickets: Ticket[]; providers: Provider[]; sales: Sale[]; onReload: () => Promise<void>; setNotice: (value: string) => void }) {
  const [selected, setSelected] = useState<Ticket | null>(null);
  const saleTicketIds = new Set(sales.map((sale) => sale.ticketId));
  const opportunities = tickets.filter((ticket) => ticket.level === "Pré Venda" && !saleTicketIds.has(ticket.id));
  const converted = sales;
  return <>
    <section className="panel table-panel"><div className="panel-heading"><div><h2>Oportunidades de pré-venda</h2><p>Chamados aguardando conversão · {opportunities.length} oportunidades</p></div></div>
      {opportunities.length ? <div className="table-scroll"><table><thead><tr><th>ABERTURA</th><th>CLIENTE</th><th>CONTATO</th><th>PROTOCOLO</th><th>PROVEDOR</th><th>AÇÃO</th></tr></thead><tbody>{opportunities.map((ticket) => <tr key={ticket.id}><td>{dateLabel(ticketOpenedAt(ticket))}</td><td><b>{ticket.customer}</b></td><td>{ticket.contact}</td><td><span className="protocol">{ticket.protocol}</span></td><td>{providers.find((item) => item.id === ticket.providerId)?.name ?? "—"}</td><td><button className="button compact-button primary" onClick={() => setSelected(ticket)}><Check size={14} /> Converter</button></td></tr>)}</tbody></table></div> : <EmptyState icon={ArrowUpRight} title="Tudo em dia" text="Novos chamados de pré-venda aparecerão aqui." />}
    </section>
    <section className="panel table-panel secondary-panel"><div className="panel-heading"><div><h2>Vendas convertidas</h2><p>Clientes com plano e instalação definidos</p></div></div>
      {converted.length ? <div className="table-scroll"><table><thead><tr><th>CLIENTE</th><th>PROVEDOR</th><th>VALOR DO PLANO</th><th>INSTALAÇÃO</th><th>CONVERSÃO</th></tr></thead><tbody>{converted.map((sale) => <tr key={sale.id}><td><b>{sale.customer}</b></td><td>{providers.find((item) => item.id === sale.providerId)?.name ?? "—"}</td><td>{currency(sale.planValue)}</td><td>{sale.installationDate}</td><td>{dateLabel(sale.convertedAt?.toDate())}</td></tr>)}</tbody></table></div> : <EmptyState icon={BadgeDollarSign} title="Nenhuma venda convertida" text="As conversões aparecerão neste relatório." />}
    </section>
    {selected && <SaleDialog ticket={selected} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await onReload(); }} setNotice={setNotice} />}
  </>;
}

function SaleDialog({ ticket, onClose, onSaved, setNotice }: { ticket: Ticket; onClose: () => void; onSaved: () => Promise<void>; setNotice: (value: string) => void }) {
  const [planValue, setPlanValue] = useState("");
  const [installationDate, setInstallationDate] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!db) return;
    setSaving(true);
    try {
      await setDoc(doc(db, "sales", ticket.id), {
        ticketId: ticket.id, providerId: ticket.providerId, customer: ticket.customer,
        planValue: Number(planValue), installationDate, convertedAt: serverTimestamp(),
      });
      setNotice("Pré-venda convertida e incluída no próximo fechamento.");
      await onSaved();
    } catch (error) { setNotice(`Erro ao converter pré-venda: ${firebaseError(error)}`); }
    finally { setSaving(false); }
  }
  return <Modal title="Converter pré-venda" onClose={onClose}><form className="form-grid" onSubmit={submit}><div className="field-span conversion-summary"><span>CLIENTE</span><b>{ticket.customer}</b><small>Protocolo {ticket.protocol}</small></div><label>Valor do plano (R$)<input required type="number" min="0" step="0.01" value={planValue} onChange={(event) => setPlanValue(event.target.value)} /></label><label>Data da instalação<input required type="date" value={installationDate} onChange={(event) => setInstallationDate(event.target.value)} /></label><div className="modal-actions"><button type="button" className="button outline" onClick={onClose}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? "Convertendo..." : "Confirmar venda"}</button></div></form></Modal>;
}

function Accesses({ users, providers, demoMode, onDemoChange, accessPreset, onClearPreset, onReload, setNotice }: { users: UserProfile[]; providers: Provider[]; demoMode: boolean; onDemoChange: (users: UserProfile[]) => void; accessPreset: { role: UserRole; providerId: string } | null; onClearPreset: () => void; onReload: () => Promise<void>; setNotice: (value: string) => void }) {
  const [dialog, setDialog] = useState<"create" | UserProfile | null>(null);
  const [deleting, setDeleting] = useState<UserProfile | null>(null);
  return <>
    <section className="panel table-panel"><div className="panel-heading"><div><h2>Usuários e permissões</h2><p>Controle os perfis de acesso à central</p></div><button className="button primary" onClick={() => setDialog("create")}><Plus size={16} /> Novo acesso</button></div>
      {users.length ? <div className="table-scroll"><table><thead><tr><th>USUÁRIO</th><th>E-MAIL</th><th>PERFIL</th><th>PROVEDOR</th><th>PRESENÇA</th><th>AÇÕES</th></tr></thead><tbody>{users.map((item) => <tr key={item.uid}><td><div className="table-person"><div className="avatar">{initials(item.name)}</div><b>{item.name}</b></div></td><td>{item.email}</td><td><span className={`role-pill role-${item.role}`}>{ROLE_LABELS[item.role]}</span></td><td>{providers.find((provider) => provider.id === item.providerId)?.name ?? "—"}</td><td><span className={`presence-pill ${item.isOnline && item.lastSeenAt && Date.now() - item.lastSeenAt.toDate().getTime() < 120_000 ? "present" : ""}`}><i />{item.isOnline && item.lastSeenAt && Date.now() - item.lastSeenAt.toDate().getTime() < 120_000 ? "Online" : "Offline"}</span></td><td><div className="row-actions"><button className="icon-button row-action" onClick={() => setDialog(item)} title="Editar perfil"><Pencil size={15} /></button><button className="icon-button row-action danger-action" onClick={() => setDeleting(item)} title="Excluir acesso"><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <EmptyState icon={Users} title="Nenhum acesso cadastrado" text="Crie um usuário para liberar o acesso à central." />}
    </section>
    {dialog && <AccessDialog initial={typeof dialog === "string" ? null : dialog} defaultRole={accessPreset?.role} defaultProviderId={accessPreset?.providerId} providers={providers} demoMode={demoMode} onDemoSave={(saved) => onDemoChange([...users.filter((item) => item.uid !== saved.uid), saved])} onClose={() => { setDialog(null); onClearPreset(); }} onSaved={async () => { setDialog(null); onClearPreset(); await onReload(); }} setNotice={setNotice} />}
    {deleting && <ConfirmDialog title="Excluir acesso?" text={`A conta de ${deleting.name} e seu perfil serão excluídos.`} onCancel={() => setDeleting(null)} onConfirm={async () => { try { if (demoMode) { onDemoChange(users.filter((item) => item.uid !== deleting.uid)); setNotice("Acesso removido apenas desta demonstração local."); } else { if (!functions) throw new Error("Firebase Functions não está configurado."); const manage = httpsCallable(functions, "manageUser"); await manage({ action: "delete", uid: deleting.uid }); setNotice("Acesso excluído."); } setDeleting(null); await onReload(); } catch (error) { setNotice(`Erro ao excluir acesso: ${firebaseError(error)}`); } }} />}
  </>;
}

function AccessDialog({ initial, defaultRole, defaultProviderId, providers, demoMode, onDemoSave, onClose, onSaved, setNotice }: { initial: UserProfile | null; defaultRole?: UserRole; defaultProviderId?: string; providers: Provider[]; demoMode: boolean; onDemoSave: (user: UserProfile) => void; onClose: () => void; onSaved: () => Promise<void>; setNotice: (value: string) => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>(initial?.role ?? defaultRole ?? "collaborator");
  const [providerId, setProviderId] = useState(initial?.providerId ?? defaultProviderId ?? "");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      if (demoMode) {
        onDemoSave({
          ...(initial ?? { uid: `demo-user-${Date.now()}`, email: email.trim(), isOnline: false }),
          name: name.trim(),
          email: initial?.email ?? email.trim(),
          role,
          ...(providerId ? { providerId } : { providerId: undefined }),
        });
        setNotice(initial
          ? "Acesso atualizado apenas nesta demonstração local; não foi alterada uma conta Firebase."
          : "Acesso de demonstração adicionado. Nenhuma conta Firebase foi criada e a senha não foi armazenada.");
      } else {
        if (!functions) throw new Error("Firebase Functions não está configurado.");
        const manage = httpsCallable(functions, "manageUser");
        if (initial) await manage({ action: "update", uid: initial.uid, name: name.trim(), role, providerId: providerId || null });
        else await manage({ action: "create", name: name.trim(), email: email.trim(), password, role, providerId: providerId || null });
        setNotice(initial ? "Acesso atualizado." : "Usuário criado com sucesso.");
      }
      await onSaved();
    } catch (error) { setNotice(`Erro ao salvar acesso: ${firebaseError(error)}`); }
    finally { setSaving(false); }
  }
  return <Modal title={initial ? "Editar acesso" : "Criar acesso"} onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <label className="field-span">Nome completo<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    {!initial && <><label className="field-span">E-mail<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="field-span">Senha inicial<input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /><small>Use pelo menos 8 caracteres. Oriente a pessoa a alterar a senha após o primeiro acesso.</small></label></>}
    <label>Perfil<select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>{Object.entries(ROLE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>Provedor<select value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">Sem provedor</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
    <div className="modal-actions"><button type="button" className="button outline" onClick={onClose}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? "Salvando..." : "Salvar acesso"}</button></div>
  </form></Modal>;
}

function Closing({ tickets, providers, sales, profile, archivedClosings, onArchive }: { tickets: Ticket[]; providers: Provider[]; sales: Sale[]; profile: UserProfile; archivedClosings: ArchivedClosing[]; onArchive: (report: ReturnType<typeof calculateClosing>, provider: Provider) => Promise<void> }) {
  const [providerId, setProviderId] = useState("");
  const [asOfDate, setAsOfDate] = useState(localDateString(new Date()));
  const [confirmArchive, setConfirmArchive] = useState<{ report: ReturnType<typeof calculateClosing>; provider: Provider } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const linkedProvider = profile.role === "provider" ? providers.find((provider) => provider.id === profile.providerId) : undefined;
  const selectedProvider = profile.role === "provider"
    ? linkedProvider
    : providers.find((provider) => provider.id === providerId) ?? providers[0];
  const report = selectedProvider ? calculateClosing(selectedProvider, tickets, sales, new Date(`${asOfDate}T12:00:00`)) : null;
  const alreadyArchived = Boolean(selectedProvider && report && archivedClosings.some((archive) =>
    archive.providerId === selectedProvider.id &&
    archive.startDate === localDateString(report.start) &&
    archive.endDate === localDateString(report.end),
  ));
  const cycleEnded = Boolean(report && report.end.getTime() < new Date(`${localDateString(new Date())}T00:00:00`).getTime());
  const canArchive = profile.role === "admin" && cycleEnded && !alreadyArchived;
  useEffect(() => {
    if (profile.role !== "provider" && !providerId && providers[0]) setProviderId(providers[0].id);
  }, [providers, profile.role, providerId]);
  return <>
    <section className="panel filters-panel closing-controls">{profile.role === "provider" ? <label>Provedor<input readOnly value={selectedProvider?.name ?? "Provedor não vinculado"} /></label> : <label>Provedor<select value={selectedProvider?.id ?? ""} onChange={(event) => setProviderId(event.target.value)}><option value="">Selecione</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>}<label>Referência do ciclo<input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} /></label></section>
    {!selectedProvider || !report ? <EmptyState icon={FileSpreadsheet} title={profile.role === "provider" ? "Provedor não vinculado" : "Cadastre um provedor"} text={profile.role === "provider" ? "Solicite ao administrador a vinculação desta conta a um provedor." : "O fechamento será calculado após o cadastro do primeiro provedor."} /> : <>
      <div className="metric-grid closing-metrics"><MetricCard label="Valor fixo" value={currency(report.fixed)} change="Contrato mensal" icon={Building2} tone="violet" /><MetricCard label="Franquia utilizada" value={`${report.includedUsed} / ${report.includedLimit}`} change="N1, N2 e Pré Venda" icon={Headset} tone="cyan" /><MetricCard label="Atendimentos excedentes" value={currency(report.excess)} change={`${report.excessCount} chamados faturáveis`} icon={ArrowUpRight} tone="amber" /><MetricCard label="Total do fechamento" value={currency(report.total)} change={`${report.tickets.length} chamados no ciclo`} icon={BadgeDollarSign} tone="green" /></div>
      <section className="panel table-panel"><div className="panel-heading"><div><h2>Detalhamento do fechamento</h2><p>{dateOnly(report.start)} — {dateOnly(report.end)} · {selectedProvider.name}</p></div><div className="row-actions"><button className="button outline" onClick={() => exportClosing(report, selectedProvider, profile.role === "admin")}><ArrowDownToLine size={16} /> Exportar Excel</button>{profile.role === "admin" && <button className="button primary" disabled={!canArchive} title={alreadyArchived ? "Este ciclo já foi arquivado." : !cycleEnded ? "O arquivamento estará disponível após o encerramento do ciclo." : undefined} onClick={() => { if (canArchive) setConfirmArchive({ report, provider: selectedProvider }); }}>{alreadyArchived ? <><Check size={16} /> Arquivado</> : <><Archive size={16} /> Arquivar fechamento</>}</button>}</div></div>
        {profile.role === "admin" && !alreadyArchived && <p className="archive-hint">{cycleEnded ? "O ciclo terminou. Arquivar remove seus atendimentos e vendas das listas ativas e os mantém disponíveis no histórico." : "O fechamento poderá ser arquivado após a data de encerramento do ciclo."}</p>}
        {report.warnings.length > 0 && <div className="warning-list">{report.warnings.map((warning) => <div className="notice warning-notice" key={warning}><Bell size={16} /> {warning}</div>)}</div>}
        <div className="table-scroll"><table><thead><tr><th>ABERTURA</th><th>PROTOCOLO</th><th>ASSUNTO</th><th>CLIENTE</th><th>CONTATO</th><th>ENDEREÇO</th>{profile.role === "admin" && <th>COLABORADOR</th>}<th>NÍVEL</th><th>DESCRIÇÃO</th><th>REGRA</th><th>VALOR</th></tr></thead><tbody>{report.tickets.map((ticket) => <tr key={ticket.id}><td>{dateLabel(ticketOpenedAt(ticket))}</td><td><span className="protocol">{ticket.protocol}</span></td><td>{ticket.subjectName ?? "—"}</td><td><b>{ticket.customer}</b></td><td>{ticket.contact}</td><td className="truncate-cell" title={ticket.address}>{ticket.address}</td>{profile.role === "admin" && <td>{ticket.collaboratorName}</td>}<td><span className={`level-pill ${levelClass(ticket.level)}`}>{ticket.level}</span></td><td className="truncate-cell" title={ticket.description}>{ticket.description}</td><td>{report.charges.get(ticket.id)?.label}</td><td>{currency(report.charges.get(ticket.id)?.amount ?? 0)}</td></tr>)}<tr className="total-row"><td colSpan={profile.role === "admin" ? 10 : 9}>Valor fixo mensal</td><td>{currency(report.fixed)}</td></tr><tr className="total-row grand-total"><td colSpan={profile.role === "admin" ? 10 : 9}>Total do fechamento</td><td>{currency(report.total)}</td></tr></tbody></table></div>
      </section>
      <section className="panel table-panel secondary-panel"><div className="panel-heading"><div><h2>Vendas convertidas no ciclo</h2><p>Valores de plano para acompanhamento · não somados à cobrança do help desk</p></div><span className="record-count">{currency(report.salesInPeriod.reduce((sum, sale) => sum + sale.planValue, 0))} em planos</span></div>
        {report.salesInPeriod.length ? <div className="table-scroll"><table><thead><tr><th>CLIENTE</th><th>VALOR DO PLANO</th><th>INSTALAÇÃO</th><th>CONVERSÃO</th></tr></thead><tbody>{report.salesInPeriod.map((sale) => <tr key={sale.id}><td><b>{sale.customer}</b></td><td>{currency(sale.planValue)}</td><td>{sale.installationDate}</td><td>{dateLabel(sale.convertedAt?.toDate())}</td></tr>)}</tbody></table></div> : <EmptyState icon={BadgeDollarSign} title="Nenhuma venda convertida neste ciclo" text="As conversões de pré-venda serão detalhadas aqui." />}
      </section>
    </>}
    {confirmArchive && <Modal title="Arquivar fechamento?" onClose={() => setConfirmArchive(null)}><p className="confirm-copy">Os {confirmArchive.report.tickets.length} atendimentos deste ciclo e as vendas vinculadas sairão das listas operacionais. O detalhamento continuará disponível na aba Fechamentos Anteriores para consulta e download em Excel.</p><div className="modal-actions"><button type="button" className="button outline" disabled={archiveBusy} onClick={() => setConfirmArchive(null)}>Cancelar</button><button type="button" className="button primary" disabled={archiveBusy} onClick={async () => { setArchiveBusy(true); await onArchive(confirmArchive.report, confirmArchive.provider); setArchiveBusy(false); setConfirmArchive(null); }}>{archiveBusy ? "Arquivando..." : "Confirmar arquivamento"}</button></div></Modal>}
  </>;
}

function ArchivedClosingsList({ archives, tickets, sales, activeTickets, activeSales, providers, profile, onArchive }: { archives: ArchivedClosing[]; tickets: Ticket[]; sales: Sale[]; activeTickets: Ticket[]; activeSales: Sale[]; providers: Provider[]; profile: UserProfile; onArchive: (report: ReturnType<typeof calculateClosing>, provider: Provider) => Promise<void> }) {
  const [pendingArchive, setPendingArchive] = useState<{ report: ReturnType<typeof calculateClosing>; provider: Provider } | null>(null);
  const sortedArchives = [...archives].sort((a, b) => b.endDate.localeCompare(a.endDate));
  const pendingCycles = profile.role === "admin" ? providers.flatMap((provider) => {
    const currentPeriod = periodFor(provider, new Date());
    const previousCycleDate = new Date(currentPeriod.start);
    previousCycleDate.setDate(previousCycleDate.getDate() - 1);
    const report = calculateClosing(provider, activeTickets, activeSales, previousCycleDate);
    const archiveId = `${provider.id}_${localDateString(report.start)}_${localDateString(report.end)}`;
    const cycleEnded = report.end.getTime() < new Date(`${localDateString(new Date())}T00:00:00`).getTime();
    return cycleEnded && !archives.some((archive) => archive.id === archiveId)
      ? [{ provider, report }]
      : [];
  }) : [];
  return <>
    {profile.role === "admin" && <section className="panel table-panel secondary-panel">
      <div className="panel-heading"><div><h2>Ciclos encerrados para arquivar</h2><p>Fechamentos do ciclo anterior que ainda não foram arquivados</p></div><span className="record-count">{pendingCycles.length} disponíveis</span></div>
      {pendingCycles.length ? <div className="table-scroll"><table><thead><tr><th>PROVEDOR</th><th>PERÍODO ENCERRADO</th><th>ATENDIMENTOS</th><th>TOTAL</th><th>AÇÃO</th></tr></thead><tbody>{pendingCycles.map(({ provider, report }) => <tr key={provider.id}><td><b>{provider.name}</b></td><td>{dateOnly(report.start)} — {dateOnly(report.end)}</td><td>{report.tickets.length}</td><td><b>{currency(report.total)}</b></td><td><button className="button primary" onClick={() => setPendingArchive({ provider, report })}><Archive size={15} /> Arquivar fechamento</button></td></tr>)}</tbody></table></div> : <EmptyState icon={Check} title="Nenhum ciclo pendente" text="Os ciclos anteriores já foram arquivados ou ainda não encerraram." />}
    </section>}
    <section className="panel table-panel secondary-panel">
      <div className="panel-heading"><div><h2>Histórico de fechamentos</h2><p>Planilhas geradas a partir dos atendimentos arquivados por ciclo</p></div><span className="record-count">{archives.length} {archives.length === 1 ? "fechamento" : "fechamentos"}</span></div>
      {sortedArchives.length ? <div className="table-scroll"><table><thead><tr><th>PROVEDOR</th><th>PERÍODO</th><th>ATENDIMENTOS</th><th>VENDAS</th><th>TOTAL</th><th>ARQUIVADO EM</th><th>PLANILHA</th></tr></thead><tbody>{sortedArchives.map((archive) => {
        const archiveTickets = tickets.filter((ticket) => ticket.archiveId === archive.id);
        const archiveSalesForCycle = sales.filter((sale) => sale.archiveId === archive.id);
        return <tr key={archive.id}><td><b>{archive.providerName}</b></td><td>{dateOnly(new Date(`${archive.startDate}T12:00:00`))} — {dateOnly(new Date(`${archive.endDate}T12:00:00`))}</td><td>{archive.ticketCount}</td><td>{currency(archive.salesTotal)}</td><td><b>{currency(archive.total)}</b></td><td>{dateLabel(archive.archivedAt?.toDate())}</td><td><button className="button outline" onClick={() => exportArchivedClosing(archive, archiveTickets, archiveSalesForCycle, profile.role === "admin")}><ArrowDownToLine size={15} /> Baixar Excel</button></td></tr>;
      })}</tbody></table></div> : <EmptyState icon={Archive} title="Nenhum fechamento arquivado" text="Os fechamentos arquivados ficarão disponíveis para consulta e download em Excel." />}
    </section>
    {pendingArchive && <Modal title="Arquivar fechamento?" onClose={() => setPendingArchive(null)}><p className="confirm-copy">Os {pendingArchive.report.tickets.length} atendimentos deste ciclo e as vendas vinculadas sairão das listas operacionais. O detalhamento continuará disponível neste histórico para consulta e download em Excel.</p><div className="modal-actions"><button type="button" className="button outline" onClick={() => setPendingArchive(null)}>Cancelar</button><button type="button" className="button primary" onClick={async () => { await onArchive(pendingArchive.report, pendingArchive.provider); setPendingArchive(null); }}>Confirmar arquivamento</button></div></Modal>}
  </>;
}

function calculateClosing(provider: Provider, allTickets: Ticket[], sales: Sale[], date = new Date()) {
  const { start, end } = periodFor(provider, date);
  const tickets = allTickets.filter((ticket) => ticket.providerId === provider.id && ticket.createdAt && ticket.createdAt.toDate() >= start && ticket.createdAt.toDate() <= end).sort((a, b) => (a.createdAt?.toDate().getTime() ?? 0) - (b.createdAt?.toDate().getTime() ?? 0));
  const billable = tickets;
  const included = billable.filter((ticket) => ticket.level !== "Massivo");
  const includedUsed = Math.min(included.length, provider.includedCalls || 0);
  let quota = provider.includedCalls || 0;
  const charges = new Map<string, { label: string; amount: number }>();
  for (const ticket of billable) {
    if (ticket.level === "Massivo") {
      charges.set(ticket.id, { label: "Cobrança por atendimento", amount: provider.rates?.Massivo ?? 0 });
    } else if (quota > 0) {
      quota -= 1;
      charges.set(ticket.id, { label: "Incluído na franquia", amount: 0 });
    } else {
      charges.set(ticket.id, { label: "Excedente", amount: provider.rates?.[ticket.level] ?? 0 });
    }
  }
  const includedCalls = tickets.filter((ticket) => ticket.level !== "Massivo");
  const excessCount = Math.max(0, includedCalls.length - (provider.includedCalls || 0)) + tickets.filter((ticket) => ticket.level === "Massivo").length;
  const excess = [...charges.values()].reduce((sum, charge) => sum + charge.amount, 0);
  const warnings: string[] = [];
  const protocols = new Set<string>();
  for (const ticket of tickets) {
    if (protocols.has(ticket.protocol)) warnings.push(`Protocolo duplicado detectado: ${ticket.protocol}.`);
    protocols.add(ticket.protocol);
  }
  if (provider.protocolPattern) {
    try {
      const pattern = new RegExp(provider.protocolPattern);
      for (const ticket of tickets) if (!pattern.test(ticket.protocol)) warnings.push(`Protocolo fora do padrão: ${ticket.protocol}.`);
    } catch {
      warnings.push("A expressão regular configurada para os protocolos é inválida.");
    }
  }
  const salesInPeriod = sales.filter((sale) =>
    sale.providerId === provider.id &&
    sale.convertedAt &&
    sale.convertedAt.toDate() >= start &&
    sale.convertedAt.toDate() <= end,
  );
  return { start, end, tickets: [...tickets].reverse(), charges, salesInPeriod, includedUsed, includedLimit: provider.includedCalls || 0, excessCount, fixed: provider.fixedMonthly || 0, excess, total: (provider.fixedMonthly || 0) + excess, warnings };
}

function FinancialMetrics({ tickets, providers, sales, archivedClosings }: { tickets: Ticket[]; providers: Provider[]; sales: Sale[]; archivedClosings: ArchivedClosing[] }) {
  const [providerId, setProviderId] = useState("");
  const [month, setMonth] = useState(localDateString(new Date()).slice(0, 7));
  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? providers[0];
  const metrics = useMemo(() => {
    if (!selectedProvider) return [];
    const [year, selectedMonth] = month.split("-").map(Number);
    return Array.from({ length: 6 }, (_, index) => {
      const date = new Date(year, selectedMonth - 1 - (5 - index), 15);
      const report = calculateClosing(selectedProvider, tickets, sales, date);
      const archive = archivedClosings.find((item) =>
        item.providerId === selectedProvider.id &&
        item.startDate === localDateString(report.start) &&
        item.endDate === localDateString(report.end),
      );
      return {
        month: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(date),
        valor: archive?.total ?? report.total,
        chamados: archive?.ticketCount ?? report.tickets.length,
      };
    });
  }, [selectedProvider, tickets, sales, month, archivedClosings]);
  const current = metrics[metrics.length - 1]?.valor ?? 0;
  const average = metrics.length ? metrics.reduce((sum, item) => sum + item.valor, 0) / metrics.length : 0;
  return <>
    <section className="panel filters-panel closing-controls"><label>Provedor<select value={selectedProvider?.id ?? ""} onChange={(event) => setProviderId(event.target.value)}><option value="">Selecione</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label>Mês de referência<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></section>
    {!selectedProvider ? <EmptyState icon={BarChart3} title="Cadastre um provedor" text="Os indicadores serão calculados a partir dos fechamentos." /> : <>
      <div className="metric-grid"><MetricCard label="Fechamento de referência" value={currency(current)} change="Estimativa do ciclo selecionado" icon={BadgeDollarSign} tone="green" /><MetricCard label="Média dos últimos 6 ciclos" value={currency(average)} change="Base histórica disponível" icon={BarChart3} tone="cyan" /><MetricCard label="Chamados no ciclo" value={String(metrics.at(-1)?.chamados ?? 0)} change="No período selecionado" icon={Headset} tone="violet" /><MetricCard label="Projeção" value={currency(average)} change="Estimativa pela média recente" icon={ArrowUpRight} tone="amber" /></div>
      <section className="panel chart-panel financial-chart"><div className="panel-heading"><div><h2>Comparativo financeiro</h2><p>Fechamento mensal de {selectedProvider.name}</p></div><span className="panel-period">Últimos 6 ciclos</span></div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={metrics}><CartesianGrid stroke="#1b2b3a" vertical={false} /><XAxis dataKey="month" stroke="#71839a" tickLine={false} axisLine={false} /><YAxis stroke="#71839a" tickLine={false} axisLine={false} tickFormatter={(value) => `R$${value}`} /><Tooltip formatter={(value) => currency(Number(value))} contentStyle={{ background: "#0d1824", border: "1px solid #203448", borderRadius: 12, color: "#eaf3fc" }} /><Bar dataKey="valor" name="Fechamento" fill="#22c8e8" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div></section>
    </>}
  </>;
}

function exportTickets(tickets: Ticket[], providers: Provider[], providerName?: string, includeCollaborator = true) {
  const rows = tickets.map((ticket) => ({
    "Data de abertura": dateLabel(ticketOpenedAt(ticket)),
    Protocolo: ticket.protocol,
    Assunto: ticket.subjectName ?? "",
    Contato: ticket.contact,
    Cliente: ticket.customer,
    Endereço: ticket.address,
    "Nível do atendimento": ticket.level,
    Descrição: ticket.description,
    Provedor: providers.find((provider) => provider.id === ticket.providerId)?.name ?? "",
    ...(includeCollaborator ? { Colaborador: ticket.collaboratorName } : {}),
  }));
  downloadWorkbook(rows, providerName ? `chamados-${providerName}` : "chamados-pingdesk");
}

function exportClosing(report: ReturnType<typeof calculateClosing>, provider: Provider, includeCollaborator: boolean) {
  const rows: Record<string, string | number>[] = report.tickets.map((ticket) => ({
    Data: dateLabel(ticketOpenedAt(ticket)),
    Protocolo: ticket.protocol,
    Assunto: ticket.subjectName ?? "",
    Cliente: ticket.customer,
    Contato: ticket.contact,
    Endereço: ticket.address,
    ...(includeCollaborator ? { Colaborador: ticket.collaboratorName } : {}),
    Nível: ticket.level,
    Descrição: ticket.description,
    Regra: report.charges.get(ticket.id)?.label ?? "Não faturável",
    Valor: report.charges.get(ticket.id)?.amount ?? 0,
  }));
  for (const sale of report.salesInPeriod) {
    rows.push({
      Data: sale.installationDate,
      Protocolo: "",
      Cliente: sale.customer,
      Contato: "",
      Nível: "Venda",
      Regra: "Informativo — não somado à cobrança",
      Valor: sale.planValue,
    });
  }
  rows.push({ Data: "", Protocolo: "", Cliente: "", Contato: "", Nível: "", Regra: "Valor fixo mensal", Valor: report.fixed });
  rows.push({ Data: "", Protocolo: "", Cliente: "", Contato: "", Nível: "", Regra: "Total do fechamento", Valor: report.total });
  downloadWorkbook(rows, `fechamento-${provider.name}`);
}

function exportArchivedClosing(archive: ArchivedClosing, tickets: Ticket[], sales: Sale[], includeCollaborator: boolean) {
  const rows: Record<string, string | number>[] = tickets.map((ticket) => ({
    Data: dateLabel(ticketOpenedAt(ticket)),
    Protocolo: ticket.protocol,
    Assunto: ticket.subjectName ?? "",
    Cliente: ticket.customer,
    Contato: ticket.contact,
    Endereço: ticket.address,
    ...(includeCollaborator ? { Colaborador: ticket.collaboratorName } : {}),
    Nível: ticket.level,
    Descrição: ticket.description,
    Regra: ticket.archiveChargeLabel ?? "Não faturável",
    Valor: ticket.archiveChargeAmount ?? 0,
  }));
  for (const sale of sales) {
    rows.push({
      Data: sale.installationDate,
      Protocolo: "",
      Cliente: sale.customer,
      Contato: "",
      Nível: "Venda",
      Regra: "Informativo — não somado à cobrança",
      Valor: sale.planValue,
    });
  }
  rows.push({ Data: "", Protocolo: "", Cliente: "", Contato: "", Nível: "", Regra: "Valor fixo mensal", Valor: archive.fixed });
  rows.push({ Data: "", Protocolo: "", Cliente: "", Contato: "", Nível: "", Regra: "Total do fechamento", Valor: archive.total });
  downloadWorkbook(rows, `fechamento-arquivado-${archive.providerName}-${archive.startDate}`);
}

function downloadWorkbook(rows: Record<string, string | number>[], name: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Relatório");
  XLSX.writeFile(book, `${name.toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, "-")}.xlsx`);
}

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function levelClass(level: TicketLevel) {
  return level === "N1" ? "level-n1" : level === "N2" ? "level-n2" : level === "Massivo" ? "level-massivo" : "level-presale";
}

function EmptyState({ icon: Icon, title, text }: { icon: typeof Headset; title: string; text: string }) {
  return <div className="empty-state"><span><Icon size={20} /></span><b>{title}</b><p>{text}</p></div>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal"><header className="modal-header"><div><span className="card-kicker">CENTRAL PINGDESK</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={18} /></button></header><div className="modal-body">{children}</div></section></div>;
}

function ConfirmDialog({ title, text, onCancel, onConfirm }: { title: string; text: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onCancel}><p className="confirm-copy">{text}</p><div className="modal-actions"><button className="button outline" onClick={onCancel}>Cancelar</button><button className="button danger" disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }}>{busy ? "Excluindo..." : "Excluir"}</button></div></Modal>;
}

export default App;
