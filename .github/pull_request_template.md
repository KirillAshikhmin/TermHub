## Что и зачем

Краткое описание изменения.

## Чек-лист

- [ ] `npm run build` проходит
- [ ] `npx vitest run` зелёный
- [ ] Правки web — прогнал `npx tsc -p packages/web/tsconfig.json --noEmit`
- [ ] Правки remote-части — прогнал `packages/agent/test/e2e.full.test.ts`
- [ ] Фича сделана для всех транспортов (LAN / локальная сеть / relay), где применимо
