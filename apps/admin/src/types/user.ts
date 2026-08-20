export type UserStatus = "Active" | "Invited" | "Suspended";

export interface DemoUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: UserStatus;
  /** ISO date — sorts correctly as a plain string. */
  joined: string;
}
