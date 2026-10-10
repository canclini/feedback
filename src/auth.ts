import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { hashSecret } from "./tokens.ts";

const SESSION_DAYS = 30;
const CEREMONY_MS = 5 * 60 * 1000;
const MAX_CEREMONIES = 100;
// One user: every passkey belongs to Marcel.
const USER_ID = new TextEncoder().encode("marcel");
const SETUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class AuthError extends Error {}

interface Ceremony {
  challenge: string;
  kind: "register" | "login";
  // A registration started with the setup code signs the user in; one started
  // from a session only adds a passkey.
  setup: boolean;
  expires: number;
}

export interface Credential {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface AuthOptions {
  publicUrl: string;
  now?: () => Date;
}

// Passkeys, the one-time setup code and sessions for the web UI.
export class Auth {
  db: DatabaseSync;
  rpID: string;
  origin: string;
  now: () => Date;
  setupCode: string | null = null;
  ceremonies = new Map<string, Ceremony>();

  constructor(db: DatabaseSync, options: AuthOptions) {
    const url = new URL(options.publicUrl);
    this.db = db;
    this.rpID = url.hostname;
    this.origin = url.origin;
    this.now = options.now ?? (() => new Date());
  }

  needsSetup(): boolean {
    return this.listCredentials().length === 0;
  }

  // A fresh code on every start while no passkey exists, kept in memory only.
  // 20 characters from a 32-letter alphabet: 100 bits.
  issueSetupCode(): string | null {
    if (!this.needsSetup()) return null;
    const chars = Array.from({ length: 20 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]);
    this.setupCode = chars.join("").replace(/(.{5})(?!$)/g, "$1-");
    return this.setupCode;
  }

  checkSetupCode(code: unknown): boolean {
    if (!this.setupCode || !this.needsSetup() || typeof code !== "string") return false;
    const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const given = Buffer.from(hashSecret(normalize(code)));
    const expected = Buffer.from(hashSecret(normalize(this.setupCode)));
    return timingSafeEqual(given, expected);
  }

  async registrationOptions(setup: boolean) {
    const options = await generateRegistrationOptions({
      rpName: "Feedback",
      rpID: this.rpID,
      userName: "marcel",
      userDisplayName: "Marcel",
      userID: USER_ID,
      attestationType: "none",
      excludeCredentials: this.allCredentialRows().map((row) => ({
        id: row.id,
        transports: parseTransports(row.transports),
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return { ceremony: this.startCeremony(options.challenge, "register", setup), options };
  }

  // Returns whether this registration came from setup (and so signs in).
  // Outside setup, a passkey is only added from a signed-in session.
  async verifyRegistration(
    ceremonyId: unknown, response: unknown, name: unknown, signedIn: boolean,
  ): Promise<{ setup: boolean }> {
    const ceremony = this.takeCeremony(ceremonyId, "register");
    if (ceremony.setup && !this.needsSetup()) throw new AuthError("Die Einrichtung ist bereits abgeschlossen.");
    if (!ceremony.setup && !signedIn) throw new AuthError("Bitte zuerst anmelden.");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      });
    } catch (error) {
      throw new AuthError(`Der Passkey wurde nicht akzeptiert: ${(error as Error).message}`);
    }
    if (!verification.verified) throw new AuthError("Der Passkey wurde nicht akzeptiert.");
    const { credential } = verification.registrationInfo;
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : "Passkey";
    this.db
      .prepare("INSERT INTO credentials (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        credential.id,
        credential.publicKey,
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        label,
        this.now().toISOString(),
      );
    if (ceremony.setup) this.setupCode = null;
    return { setup: ceremony.setup };
  }

  async authenticationOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: "required" });
    return { ceremony: this.startCeremony(options.challenge, "login", false), options };
  }

  async verifyAuthentication(ceremonyId: unknown, response: unknown): Promise<void> {
    const ceremony = this.takeCeremony(ceremonyId, "login");
    const credentialId = (response as { id?: unknown } | null)?.id;
    const row = typeof credentialId === "string" ? this.credentialRow(credentialId) : undefined;
    if (!row) throw new AuthError("Dieser Passkey ist hier nicht registriert.");
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: row.id,
          publicKey: new Uint8Array(row.public_key),
          counter: row.counter,
          transports: parseTransports(row.transports),
        },
      });
    } catch (error) {
      throw new AuthError(`Die Anmeldung wurde nicht akzeptiert: ${(error as Error).message}`);
    }
    if (!verification.verified) throw new AuthError("Die Anmeldung wurde nicht akzeptiert.");
    this.db
      .prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?")
      .run(verification.authenticationInfo.newCounter, this.now().toISOString(), row.id);
  }

  listCredentials(): Credential[] {
    return this.db
      .prepare("SELECT id, name, created_at, last_used_at FROM credentials ORDER BY created_at")
      .all() as unknown as Credential[];
  }

  // The last passkey cannot be removed: without it nobody can sign in, and
  // setup would open again to anyone who sees the next setup code.
  deleteCredential(id: string): void {
    if (this.listCredentials().length <= 1) throw new AuthError("Der letzte Passkey kann nicht entfernt werden.");
    this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
  }

  createSession(): { token: string; maxAge: number } {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const maxAge = SESSION_DAYS * 24 * 60 * 60;
    this.db
      .prepare("INSERT INTO sessions (hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(hashSecret(token), now.toISOString(), new Date(now.getTime() + maxAge * 1000).toISOString());
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
    return { token, maxAge };
  }

  isSession(token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db
      .prepare("SELECT 1 FROM sessions WHERE hash = ? AND expires_at > ?")
      .get(hashSecret(token), this.now().toISOString());
    return row !== undefined;
  }

  endSession(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(hashSecret(token));
  }

  private startCeremony(challenge: string, kind: Ceremony["kind"], setup: boolean): string {
    const now = Date.now();
    for (const [id, ceremony] of this.ceremonies) {
      if (ceremony.expires < now) this.ceremonies.delete(id);
    }
    if (this.ceremonies.size >= MAX_CEREMONIES) {
      this.ceremonies.delete(this.ceremonies.keys().next().value!);
    }
    const id = randomBytes(16).toString("base64url");
    this.ceremonies.set(id, { challenge, kind, setup, expires: now + CEREMONY_MS });
    return id;
  }

  // A ceremony is used once, whether it succeeds or not.
  private takeCeremony(id: unknown, kind: Ceremony["kind"]): Ceremony {
    const ceremony = typeof id === "string" ? this.ceremonies.get(id) : undefined;
    if (typeof id === "string") this.ceremonies.delete(id);
    if (!ceremony || ceremony.kind !== kind || ceremony.expires < Date.now()) {
      throw new AuthError("Der Vorgang ist abgelaufen. Bitte nochmals versuchen.");
    }
    return ceremony;
  }

  private allCredentialRows() {
    return this.db.prepare("SELECT id, transports FROM credentials").all() as unknown as {
      id: string;
      transports: string | null;
    }[];
  }

  private credentialRow(id: string) {
    return this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as unknown as
      | { id: string; public_key: Uint8Array; counter: number; transports: string | null }
      | undefined;
  }
}

function parseTransports(value: string | null): AuthenticatorTransport[] | undefined {
  return value ? (JSON.parse(value) as AuthenticatorTransport[]) : undefined;
}
