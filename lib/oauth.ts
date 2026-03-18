/**
 * Simple OAuth token management for MCP access.
 * Single-user system — tokens are validated against AGENT_FORGE_API_SECRET.
 */

import { randomBytes, createHash } from "crypto";

const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

interface TokenRecord {
  accessToken: string;
  clientId: string;
  expiresAt: number;
}

interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  expiresAt: number;
}

// In-memory stores — tokens survive for the lifetime of the serverless function
const tokens = new Map<string, TokenRecord>();
const authCodes = new Map<string, AuthCodeRecord>();

// ── Authorization Codes ─────────────────────────────────────────

/**
 * Store an authorization code for later exchange.
 * Used by the /oauth/authorize endpoint.
 */
export function storeAuthCode(
  clientId: string,
  redirectUri: string,
  codeChallenge: string | null,
  codeChallengeMethod: string | null
): string {
  const code = randomBytes(32).toString("hex");
  authCodes.set(code, {
    code,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  });
  return code;
}

/**
 * Exchange an authorization code for an access token.
 * Validates PKCE code_verifier if a code_challenge was stored.
 */
export function exchangeAuthCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string
): { access_token: string; token_type: string; expires_in: number } | null {
  const record = authCodes.get(code);
  if (!record) return null;

  // Single-use: delete immediately
  authCodes.delete(code);

  // Validate expiry
  if (Date.now() > record.expiresAt) return null;

  // Validate client_id and redirect_uri match
  if (record.clientId !== clientId) return null;
  if (record.redirectUri !== redirectUri) return null;

  // Validate PKCE if code_challenge was provided
  if (record.codeChallenge) {
    if (!codeVerifier) return null;

    if (record.codeChallengeMethod === "S256") {
      const computed = createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      if (computed !== record.codeChallenge) return null;
    } else {
      // Plain method
      if (codeVerifier !== record.codeChallenge) return null;
    }
  }

  // Issue token
  return issueAccessToken(clientId);
}

// ── Token Issuance ──────────────────────────────────────────────

function issueAccessToken(clientId: string): {
  access_token: string;
  token_type: string;
  expires_in: number;
} {
  const accessToken = `af_${randomBytes(32).toString("hex")}`;
  const expiresAt = Date.now() + TOKEN_EXPIRY_SECONDS * 1000;
  tokens.set(accessToken, { accessToken, clientId, expiresAt });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_EXPIRY_SECONDS,
  };
}

/**
 * Generate an access token from client credentials.
 * Validates the client_secret against AGENT_FORGE_API_SECRET.
 */
export function issueToken(clientId: string, clientSecret: string): {
  access_token: string;
  token_type: string;
  expires_in: number;
} | null {
  const secret = process.env.AGENT_FORGE_API_SECRET;
  if (!secret || clientSecret !== secret) return null;
  return issueAccessToken(clientId);
}

/**
 * Validate a Bearer token.
 * Accepts both OAuth-issued tokens (af_...) and the raw API secret.
 */
export function validateToken(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);

  // Accept raw API secret directly (for Claude Code and backward compat)
  const secret = process.env.AGENT_FORGE_API_SECRET;
  if (secret && token === secret) return true;

  // Check OAuth-issued tokens
  const record = tokens.get(token);
  if (!record) return false;
  if (Date.now() > record.expiresAt) {
    tokens.delete(token);
    return false;
  }
  return true;
}

// ── Client Registration ─────────────────────────────────────────

const registeredClients = new Map<string, { clientId: string; clientSecret: string; clientName: string }>();

/**
 * Register a new OAuth client (Dynamic Client Registration).
 */
export function registerClient(clientName: string): {
  client_id: string;
  client_secret: string;
  client_name: string;
} {
  const clientId = `af_client_${randomBytes(16).toString("hex")}`;
  const clientSecret = process.env.AGENT_FORGE_API_SECRET ?? "";
  registeredClients.set(clientId, { clientId, clientSecret, clientName: clientName });

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientName,
  };
}
