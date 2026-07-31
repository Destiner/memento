import { users, type User } from '../db.js';
import { type Router } from '../http.js';

export function registerUserRoutes(router: Router): void {
  router.on('POST', '/users', (req) => {
    const input = JSON.parse(req.body) as { email?: string };
    if (!input.email || !input.email.includes('@')) {
      return { status: 400, body: { error: 'valid email required' } };
    }
    const user: User = {
      id: `usr_${users.all().length + 1}`,
      email: input.email.toLowerCase(),
      createdAt: Date.now(),
    };
    return { status: 201, body: users.insert(user) };
  });

  router.on('GET', '/users', () => ({ status: 200, body: users.all() }));
}
