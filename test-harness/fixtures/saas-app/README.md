# saas-app

Small SaaS auth service used as a harness fixture. Password resets issue a
single-use token and email a reset link to the user.

```sh
bun install
bun run check   # tsc --noEmit && bun test
```
