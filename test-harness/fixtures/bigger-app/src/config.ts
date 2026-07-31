export interface Config {
  port: number;
  webhookSecret: string | undefined;
  queueUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    webhookSecret: env.WEBHOOK_SECRET,
    queueUrl: env.QUEUE_URL ?? 'broker://local',
  };
}
