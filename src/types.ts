export type UserRole = "admin" | "collaborator" | "provider";
export type TicketLevel = "N1" | "N2" | "Massivo" | "Pré Venda";

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  providerId?: string;
  isOnline?: boolean;
  isPaused?: boolean;
  lastSeenAt?: { toDate: () => Date };
  onlineSince?: { toDate: () => Date };
  pauseSince?: { toDate: () => Date } | null;
  lastOnlineDurationSeconds?: number;
  lastPauseDurationSeconds?: number;
}

export interface Provider {
  id: string;
  name: string;
  cnpj: string;
  includedCalls: number;
  fixedMonthly: number;
  rates: Record<TicketLevel, number>;
  billingStartDay: number;
  billingEndDay: number;
  protocolPattern: string;
  createdAt?: { toDate: () => Date };
}

export interface Ticket {
  id: string;
  providerId: string;
  subjectId?: string;
  subjectName?: string;
  collaboratorId: string;
  collaboratorName: string;
  protocol: string;
  contact: string;
  customer: string;
  address: string;
  level: TicketLevel;
  description: string;
  clientCreatedAt?: { toDate: () => Date };
  createdAt?: { toDate: () => Date };
  archiveId?: string;
  archiveChargeLabel?: string;
  archiveChargeAmount?: number;
}

export interface ProviderComment {
  id: string;
  ticketId: string;
  providerId: string;
  providerName: string;
  protocol: string;
  comment: string;
  authorUid: string;
  createdAt?: { toDate: () => Date };
}

export interface TicketSubject {
  id: string;
  providerIds?: string[];
  providerId?: string;
  name: string;
  level: TicketLevel;
  defaultDescription: string;
  createdAt?: { toDate: () => Date };
}

export interface Sale {
  id: string;
  ticketId: string;
  providerId: string;
  customer: string;
  planValue: number;
  installationDate: string;
  convertedAt?: { toDate: () => Date };
  archiveId?: string;
}

export interface ArchivedClosing {
  id: string;
  providerId: string;
  providerName: string;
  startDate: string;
  endDate: string;
  ticketCount: number;
  saleCount: number;
  fixed: number;
  excess: number;
  total: number;
  includedUsed: number;
  includedLimit: number;
  excessCount: number;
  salesTotal: number;
  archivedAt?: { toDate: () => Date };
}

export interface Actuation {
  id: string;
  providerId: string;
  providerName: string;
  collaboratorId: string;
  collaboratorName: string;
  serviceDate: string;
  startTime: string;
  endTime: string;
  createdAt?: { toDate: () => Date };
  updatedAt?: { toDate: () => Date };
}

export const TICKET_LEVELS: TicketLevel[] = [
  "N1",
  "N2",
  "Massivo",
  "Pré Venda",
];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrador",
  collaborator: "Colaborador",
  provider: "Provedor",
};
