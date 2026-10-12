#!/usr/bin/env node
/*
 * 대시보드 비밀번호 변경: 기존 암호화 파일을 새 비밀번호로 다시 암호화합니다.
 *   OLD_PASSWORD=기존 NEW_PASSWORD=새비번 node scripts/rekey.mjs
 * 실행 후 GitHub Secret DASHBOARD_PASSWORD도 새 비밀번호로 바꿔야 합니다.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMeta, openMeta, encryptJson, decryptJson } from './crypto.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'data');
const { OLD_PASSWORD, NEW_PASSWORD } = process.env;
if (!OLD_PASSWORD || !NEW_PASSWORD) { console.error('OLD_PASSWORD, NEW_PASSWORD 환경 변수가 필요합니다.'); process.exit(1); }

const rd = (p) => JSON.parse(readFileSync(p, 'utf8'));
const wr = (p, o) => writeFileSync(p, JSON.stringify(o) + '\n');
const oldKey = await openMeta(rd(join(OUT, 'meta.json')), OLD_PASSWORD);
const { meta, key } = await createMeta(NEW_PASSWORD);
// 닥터빌(docs/data) + 팜빌(docs/data/pv) 스냅샷, 포인트 집계까지 모두 재암호화
const encIn = (dir) => existsSync(join(dir, 'snapshots')) ? readdirSync(join(dir, 'snapshots')).filter((f) => f.endsWith('.enc.json')).map((f) => join(dir, 'snapshots', f)) : [];
const files = [join(OUT, 'index.enc.json'), ...encIn(OUT), join(OUT, 'pv', 'index.enc.json'), ...encIn(join(OUT, 'pv')), join(OUT, 'points.enc.json')].filter((f) => existsSync(f));
for (const f of files) wr(f, await encryptJson(key, await decryptJson(oldKey, rd(f))));
wr(join(OUT, 'meta.json'), meta);
console.log(`비밀번호 변경 완료: ${files.length}개 파일 재암호화`);
