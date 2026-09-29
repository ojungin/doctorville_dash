#!/usr/bin/env node
/*
 * 주간 스냅샷 생성 스크립트
 *
 * 사용법
 *   node scripts/build.mjs                 # 구글시트(서비스 계정)에서 읽어 집계
 *   node scripts/build.mjs --csv 파일.csv   # 로컬 CSV로 테스트 (CSV는 저장소에 커밋 금지)
 *
 * 환경 변수 (GitHub Secrets)
 *   GOOGLE_SERVICE_ACCOUNT_JSON  서비스 계정 키 JSON 전체 문자열
 *   SHEET_ID                     구글시트 ID
 *   SHEET_RANGE                  (선택) 읽을 시트/범위, 기본값 '시트1'
 *
 * 출력 (docs/data/)
 *   latest.json               최신 스냅샷
 *   snapshots/<YYYY-Www>.json 주차별 스냅샷 (같은 주 재실행 시 덮어씀)
 *   index.json                스냅샷 목록 + 주간 KPI 이력
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { aggregate, historyEntry } = require('./aggregate.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'data');

function parseCsv(s) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64url(sig)}` })
  });
  if (!res.ok) throw new Error(`토큰 발급 실패 (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function readSheet() {
  const { GOOGLE_SERVICE_ACCOUNT_JSON, SHEET_ID, SHEET_RANGE = '시트1' } = process.env;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SHEET_ID) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON, SHEET_ID 환경 변수가 필요합니다.');
  const token = await accessToken(JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}?valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`시트 조회 실패 (${res.status}): ${await res.text()}`);
  return (await res.json()).values || [];
}

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, o) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o) + '\n'); }

async function main() {
  const i = process.argv.indexOf('--csv');
  const rows = i > -1 ? parseCsv(readFileSync(process.argv[i + 1], 'utf8')) : await readSheet();
  if (rows.length < 2) throw new Error('시트에 데이터가 없습니다.');
  const snap = aggregate(rows);

  // 안전장치: 개인 식별 필드가 결과에 섞이지 않았는지 확인
  const text = JSON.stringify(snap);
  if (/@[a-z0-9-]+\.[a-z]/i.test(text)) throw new Error('집계 결과에 이메일 형태 문자열이 포함되어 중단합니다.');

  writeJson(join(OUT, 'latest.json'), snap);
  writeJson(join(OUT, 'snapshots', `${snap.week}.json`), snap);

  const idxPath = join(OUT, 'index.json');
  const index = readJson(idxPath, { snapshots: [] });
  index.snapshots = index.snapshots.filter((s) => s.week !== snap.week);
  index.snapshots.push(historyEntry(snap));
  index.snapshots.sort((a, b) => a.week.localeCompare(b.week));
  index.updatedAt = snap.generatedAt;
  writeJson(idxPath, index);

  console.log(`스냅샷 ${snap.week} (${snap.weekStart}~${snap.weekEnd}) 생성: 총 ${snap.kpi.total.toLocaleString()}명, 주간 신규 ${snap.kpi.newWeek}명`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
