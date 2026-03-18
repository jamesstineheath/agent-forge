/**
 * Simple OAuth token management for MCP access.
 * Single-user system — tokens are validated against AGENT_FORGE_API_SECRET.
 */

import { randomBytes, createHmac } from "crypto";

const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

interface TokenRecord {
  accessToken: string;
  clientId: string;
  expiresAt: number;
}

// In-memory token store — tokens survive for the lifetime of the serverless function
// For a single-user system this is fine; worst case the client re-authenticates
const tokens = new Map<string, TokenRecord>();

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

// Registered clients (in-memory, single-user system)
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
  // For DCR, the client secret IS the API secret — single-user system
  const clientSecret = process.env.AGENT_FORGE_API_SECRET ?? "";

  registeredClients.set(clientId, { clientId, clientSecret, clientName: clientName });

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientName,
  };
}
