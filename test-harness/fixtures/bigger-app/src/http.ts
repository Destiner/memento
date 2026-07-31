export interface Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface Response {
  status: number;
  body: unknown;
}

export type Handler = (req: Request) => Response | Promise<Response>;

export class Router {
  private routes = new Map<string, Handler>();

  on(method: string, path: string, handler: Handler): void {
    this.routes.set(`${method} ${path}`, handler);
  }

  async dispatch(req: Request): Promise<Response> {
    const handler = this.routes.get(`${req.method} ${req.path}`);
    if (!handler) return { status: 404, body: { error: 'not found' } };
    try {
      return await handler(req);
    } catch (error) {
      return { status: 500, body: { error: String(error) } };
    }
  }
}
