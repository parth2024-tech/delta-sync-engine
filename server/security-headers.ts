/**
 * Security middleware - adds security headers to all responses.
 *
 * Headers included:
 * - X-Content-Type-Options: Prevents MIME type sniffing
 * - X-Frame-Options: Prevents clickjacking
 * - X-XSS-Protection: Legacy XSS protection for older browsers
 * - Strict-Transport-Security: Enforces HTTPS (if in production)
 * - Content-Security-Policy: Controls what resources can be loaded
 */

import type { Handler } from "@tanstack/start";

export interface SecurityHeadersOptions {
  enableHsts?: boolean; // Enable HSTS header (default: true for production)
  hstsMaxAge?: number; // HSTS max age in seconds (default: 31536000 = 1 year)
  cspDirectives?: Record<string, string>; // Custom CSP directives
}

const defaultCspDirectives = {
  "default-src": "'self'",
  "script-src": "'self'",
  "style-src": "'self' 'unsafe-inline'",
  "img-src": "'self' data: https:",
  "font-src": "'self' data:",
  "connect-src": "'self'",
  "frame-ancestors": "'none'",
  "base-uri": "'self'",
  "form-action": "'self'",
};

export function securityHeaders(
  options: SecurityHeadersOptions = {},
): Handler {
  const {
    enableHsts = process.env.NODE_ENV === "production",
    hstsMaxAge = 31536000,
    cspDirectives = defaultCspDirectives,
  } = options;

  return async (event) => {
    // Set security headers
    event.node.res.setHeader("X-Content-Type-Options", "nosniff");
    event.node.res.setHeader("X-Frame-Options", "DENY");
    event.node.res.setHeader("X-XSS-Protection", "1; mode=block");

    if (enableHsts) {
      event.node.res.setHeader(
        "Strict-Transport-Security",
        `max-age=${hstsMaxAge}; includeSubDomains; preload`,
      );
    }

    // Build CSP header
    const csp = Object.entries(cspDirectives)
      .map(([key, value]) => `${key} ${value}`)
      .join("; ");
    event.node.res.setHeader("Content-Security-Policy", csp);

    // CORS headers - allow same-origin only by default
    const origin = event.node.req.headers.origin;
    if (origin) {
      event.node.res.setHeader("Access-Control-Allow-Origin", origin);
      event.node.res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      event.node.res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      event.node.res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  };
}
