# claude-code-pxy

A proxy server that lets you make Anthropic API calls using your Claude subscription authentication instead of API keys.

Sits between your frontend (SillyTavern, etc.) and `https://api.anthropic.com/v1/messages`, handling OAuth authentication and token management automatically.

## Quick Start

Requires Node.js 18+.

```bash
git clone <repo-url>
cd claude-code-pxy
npm install
```

### Linux / Mac

```bash
./run.sh
```

### Windows

```bat
run.bat
```

### Docker

```bash
docker-compose up
```

Then visit `http://localhost:42069/auth/login` to authenticate (browser won't auto-open in Docker).

---

Your browser will open automatically to authenticate with your Claude account. Once authenticated, the proxy is ready to accept requests on `http://localhost:42069`.

## Connecting SillyTavern

1. Set **API** to `Chat Completion`
2. Set **Chat Completion Source** to `Claude`
3. Under **Reverse Proxy**, set the **Proxy Server URL** to `http://localhost:42069/v1`
4. Set **Proxy Password** to anything non-empty
5. Pick a specific dated **model** name (e.g. `claude-sonnet-4-20250514`) — "latest" won't work
6. Click **Connect**

## Authentication

### OAuth (default)

On first run, your browser opens to `http://localhost:42069/auth/login`. Authorize with your Claude account and paste the code back into the page. Tokens are saved to `~/.claude-code-proxy/tokens.json` and refresh automatically.

- Check status: `http://localhost:42069/auth/status`
- Re-authenticate: `http://localhost:42069/auth/login`
- Logout: `http://localhost:42069/auth/logout`

### Checking whether your credentials still work

The proxy prints its credential state and the login URL on every startup, whether
or not you are authenticated:

```
Authentication Status:
  Ready (OAuth tokens) - valid until 10/7/2026, 6:26:17 AM
  Log in / re-authenticate: http://localhost:42069/auth/login
  Check status:             http://localhost:42069/auth/status
```

`GET /auth/status` reports the same thing as JSON:

```json
{
  "authenticated": true,
  "state": "refreshable",
  "source": "oauth",
  "expires_at": "2026-10-06T23:26:17.399Z",
  "login_url": "http://localhost:42069/auth/login"
}
```

| `state` | Meaning |
| --- | --- |
| `valid` | Access token is fresh and good to use. |
| `refreshable` | Access token is stale or expiring, but a refresh token is held — it renews on the next request. |
| `expired` | Access token is past its expiry and there is no refresh token. Log in again. |
| `none` | No credentials found at all. |

`source` is `oauth` (the proxy's own tokens), `claude_code` (the fallback
credentials below), or `api_key` (an `x-api-key` override from the client).
`authenticated` is true for both `valid` and `refreshable`.

This check is local — it reads expiry timestamps rather than calling the
Anthropic API, so it costs nothing and cannot tell you if a token was revoked
server-side. A revoked token surfaces as a 401 on the first real request.

### Claude Code Fallback

If you have Claude Code installed, the proxy can use its credentials as a fallback. This is enabled by default (`fallback_to_claude_code: true` in config). No setup needed — it reads from `~/.claude/.credentials.json` automatically.

### Token Priority

1. `x-api-key` header (if provided in requests)
2. OAuth tokens from `~/.claude-code-proxy/tokens.json`
3. Claude Code credentials (if fallback enabled)

## Configuration

Edit `config/config.local.json` to change settings. This file is auto-created on first run from `config.json`, and automatically updated with new keys when `config.json` is upgraded. Environment variables override the file.

### Config Options

| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| `port` | `PORT` | `42069` | Server port |
| `host` | `HOST` | `""` | Bind address. Empty = auto-detect (`127.0.0.1` native, `0.0.0.0` Docker) |
| `log_level` | `LOG_LEVEL` | `"INFO"` | Console log level: `ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE` |
| `log_file` | `LOG_FILE` | `false` | Enable file logging to `logs/proxy-YYYY-MM-DD.log` |
| `log_file_level` | `LOG_FILE_LEVEL` | `"DEBUG"` | File log level (independent of console level) |
| `filter_sampling_params` | `FILTER_SAMPLING_PARAMS` | `false` | Remove duplicate temperature/top_p params (needed for some models) |
| `auto_open_browser` | `AUTO_OPEN_BROWSER` | `true` | Auto-open browser for OAuth on first run |
| `fallback_to_claude_code` | `FALLBACK_TO_CLAUDE_CODE` | `true` | Use Claude Code credentials if OAuth tokens unavailable |
| `strip_ttl` | `STRIP_TTL` | `true` | Remove `ttl` from `cache_control` objects (API doesn't accept it) |
| `max_body_bytes` | `MAX_BODY_BYTES` | `10000000` | Max request body size (10MB) |
| `beta_header` | `BETA_HEADER` | `"claude-code-..."` | Anthropic beta features header |

## API

The proxy exposes a single API endpoint:

```
POST /v1/messages
```

Uses Anthropic's native schema (not OpenAI-compatible). The proxy:

1. Prepends a required system prompt identifying as Claude Code
2. Strips `ttl` from `cache_control` objects (if `strip_ttl` enabled)
3. Filters duplicate sampling parameters (if `filter_sampling_params` enabled)
4. Adds authentication headers
5. Forwards to `https://api.anthropic.com/v1/messages`
6. Streams the response back

On a 401 response, the proxy automatically refreshes the token and retries once.

## Project Structure

```
run.sh / run.bat        Startup scripts
config/
  config.json           Base config (versioned, don't edit)
  config.local.json     Your overrides (gitignored, auto-created)
  docker/config.json    Docker-specific overrides
src/
  main.js               Entry point
  config.js             Config loader with version-merge
  logger.js             Transport-based logger (console + file)
  token-manager.js      Unified token acquisition and refresh
  oauth.js              PKCE OAuth flow and auth routes
  proxy.js              Request processing and API proxying
  http-server.js        HTTP server, routing, CORS
  static/               Login and callback HTML pages
test/                   Jest test suites
```

## Development

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```
