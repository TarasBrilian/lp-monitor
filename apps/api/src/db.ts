import postgres from 'postgres';

export const sql = postgres(process.env.DATABASE_URL ?? 'postgres://lpmon:lpmon-dev@127.0.0.1:5433/lpmon', {
  max: 10,
  onnotice: () => {},
});
