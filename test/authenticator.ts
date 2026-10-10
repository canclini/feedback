// A software passkey for tests: a real P-256 key, attestation format "none",
// and signed assertions, so the server's WebAuthn verification runs for real.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [key: string]: Cbor };

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

export class SoftAuthenticator {
  origin: string;
  id = randomBytes(16);
  privateKey: KeyObject;
  publicKey: KeyObject;
  counter = 0;

  constructor(origin: string) {
    this.origin = origin;
    ({ privateKey: this.privateKey, publicKey: this.publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }));
  }

  get credentialId(): string {
    return b64u(this.id);
  }

  create(options: { challenge: string; rp: { id: string } }) {
    const jwk = this.publicKey.export({ format: "jwk" });
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      sha256(options.rp.id),
      Buffer.from([0x45]), // user present, user verified, attested credential data
      Buffer.alloc(4), // counter 0
      Buffer.alloc(16), // aaguid
      idLength,
      this.id,
      cbor(coseKey),
    ]);
    const clientData = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false });
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64u(Buffer.from(clientData)),
        attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  get(options: { challenge: string; rpId: string }) {
    this.counter++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(options.rpId), Buffer.from([0x05]), counter]);
    const clientData = JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false });
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64u(Buffer.from(clientData)),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: b64u(Buffer.from("marcel")),
      },
      clientExtensionResults: {},
    };
  }
}
