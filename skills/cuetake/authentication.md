# Login before recording

The default recorder launches an isolated browser context. It does not inherit the user's ordinary Chrome login. Use a named CueTake auth profile to restore an authorized session.

## MCP sequence

1. `cuetake_auth_open({url: "https://your-app.example/login", profile: "product-demo"})` opens a separate headed browser and returns a session ID. No recording starts.
2. The user completes login, including SSO/2FA. After they confirm completion, `cuetake_auth_save({sessionId})` saves state and closes that browser.
3. Call `cuetake_record({scenarioPath, outputDir, authProfile: "product-demo"})`.
4. In the scenario's `prepare`, wait for a reliable authenticated anchor. If it is absent or the site redirects to login, fail before capture and renew the profile.

The CLI accepts `--auth-profile product-demo` for already-saved profiles. The state loader uses Playwright `storageState`, including cookies, localStorage, and IndexedDB. See [Playwright authentication](https://playwright.dev/docs/auth).

Files live in `~/.local/share/cuetake/auth/<profile>.json` (or `CUETAKE_AUTH_DIR`). The directory is created with mode 0700; files are atomically saved with mode 0600. Files contain reusable session secrets and are not encrypted by CueTake. Never commit them, include them in a shared take, or paste their contents into agent messages. The take records only an authenticated-state boolean.

SessionStorage, device-bound sessions, passkeys, CAPTCHA, and some anti-automation SSO flows may require a different preparation path. A saved state does not bypass those controls or guarantee a session has not expired. The preferred flow remains authenticate before capture; refresh/re-authenticate when the site requires it.

Acceptance coverage: a local browser fixture verifies cookie/localStorage restore and file permissions. No real account has been logged into or exported during this implementation.
