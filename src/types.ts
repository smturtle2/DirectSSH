export type AuthDraft =
  | {
      kind: "password";
      password: string;
    }
  | {
      kind: "key";
      private_key: string;
      passphrase: string | null;
    }
  | {
      kind: "saved";
    };

export interface SaveProfileRequest {
  id: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthDraft;
}

export interface ProfileSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_kind: "password" | "key";
  auth_label: string;
  updated_at: number;
}

export interface TerminalOutput {
  session_id: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface TerminalStatus {
  session_id: string;
  status: "connecting" | "connected" | "exited" | "disconnected" | "error";
  message: string | null;
}
