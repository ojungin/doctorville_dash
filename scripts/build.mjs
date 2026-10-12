#!/usr/bin/env node
/*
 * 주간 스냅샷 생성 스크립트
 *
 * 데이터 소스 (위에서부터 우선 적용)
 *   A. Apps Script 웹앱 (기본, Google Cloud 불필요)
 *      APPS_SCRIPT_URL, APPS_SCRIPT_TOKEN — 시트에 붙인 Apps Script가 집계치만 반환 (apps-script/ 참고)
 *   B. 서비스 계정 (선택)
 *      GOOGLE_SERVICE_ACCOUNT_JSON, SHEET_ID, SHEET_RANGE
 *   C. 로컬 CSV 테스트: node scripts/build.mjs --csv 파일.csv (CSV는 저장소에 커밋 금지)
 *
 * 서비스 선택: --svc dv(기본, 닥터빌 회원 '시트1') | --svc pv(팜빌 회원 '팜빌' 탭)  (환경 변수 SVC도 가능)
 *
 * 환경 변수 (GitHub Secrets)
 *   APPS_SCRIPT_URL              Apps Script 웹앱 URL (…/exec)
 *   APPS_SCRIPT_TOKEN            Apps Script에 저장한 접근 토큰
 *   GOOGLE_SERVICE_ACCOUNT_JSON  서비스 계정 키 JSON 전체 문자열
 *   SHEET_ID                     구글시트 ID
 *   SHEET_RANGE                  (선택) 읽을 시트/범위, 기본값 '시트1'
 *   SHEET_RANGE_PV               (선택) 팜빌 시트/범위, 기본값 '팜빌'
 *   DASHBOARD_PASSWORD           대시보드 접속 비밀번호 (데이터 암호화 키)
 *
 * 출력 (docs/data/, 모두 AES-256-GCM 암호화 — 평문 데이터는 저장소에 남지 않음)
 *   meta.json                     키 유도 정보 + 비밀번호 검증값 (데이터 없음)
 *   index.enc.json                스냅샷 목록 + 주간 KPI 이력
 *   snapshots/<YYYY-Www>.enc.json 주차별 스냅샷 (같은 주 재실행 시 덮어씀)
 *   pv/index.enc.json, pv/snapshots/<YYYY-Www>.enc.json   팜빌 (같은 meta.json 키 사용)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createMeta, openMeta, encryptJson, decryptJson } from './crypto.mjs';
import { createSign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { aggregate, historyEntry } = require('./aggregate.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'data');
const argSvc = (() => { const k = process.argv.indexOf('--svc'); return k > -1 ? process.argv[k + 1] : process.env.SVC; })();
const SVC = argSvc === 'pv' ? 'pv' : 'dv';
const SVC_NAME = SVC === 'pv' ? '팜빌' : '닥터빌';
const OUT = SVC === 'pv' ? join(DATA, 'pv') : DATA;   // meta.json은 항상 docs/data/에 하나

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
  const { GOOGLE_SERVICE_ACCOUNT_JSON, SHEET_ID } = process.env;
  const SHEET_RANGE = SVC === 'pv' ? (process.env.SHEET_RANGE_PV || '팜빌') : (process.env.SHEET_RANGE || '시트1');
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SHEET_ID) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON, SHEET_ID 환경 변수가 필요합니다.');
  const token = await accessToken(JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}?valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`시트 조회 실패 (${res.status}): ${await res.text()}`);
  return (await res.json()).values || [];
}

// Apps Script 웹앱에서 집계 결과(개인정보 없음)를 받아옴. 토큰은 URL이 아닌 POST 본문으로 전달
// 현재 Code.gs(v2): 대시보드 비밀번호로 확인 → 시트에 저장된 최신 주차 집계(action 'get')를 받아 저장본으로 게시
// (예전 토큰 방식 Apps Script 응답 { snapshot }도 계속 인식)
async function fetchAppsScript() {
  const { APPS_SCRIPT_URL, APPS_SCRIPT_TOKEN, DASHBOARD_PASSWORD } = process.env;
  if (!DASHBOARD_PASSWORD && !APPS_SCRIPT_TOKEN) throw new Error('DASHBOARD_PASSWORD 환경 변수가 필요합니다.');
  const req = { action: 'get', password: DASHBOARD_PASSWORD, svc: SVC };
  if (APPS_SCRIPT_TOKEN) req.token = APPS_SCRIPT_TOKEN;
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(req)
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Apps Script 응답이 JSON이 아닙니다 (${res.status}). 웹앱 배포 설정(액세스: 모든 사용자)을 확인하세요.`); }
  if (!body.ok) throw new Error(`Apps Script 오류: ${body.error || 'unknown'}`);
  const snap = body.snap || body.snapshot;
  if (!snap) throw new Error(`시트에 저장된 ${SVC_NAME} 주차 집계가 없습니다. 대시보드 ${SVC === 'pv' ? '[팜빌 회원]' : '[회원 정보]'} 탭에서 [갱신]을 먼저 눌러 주세요.`);
  if ((snap.svc || 'dv') !== SVC) throw new Error(`Apps Script가 ${SVC_NAME} 집계를 돌려주지 않았습니다. Code.gs를 최신 버전(팜빌 지원)으로 바꾸고 새 버전으로 배포해 주세요.`);
  if (!snap || snap.schema !== 1 || !snap.kpi || !snap.week) throw new Error('Apps Script 응답 형식이 올바르지 않습니다.');
  return snap;
}

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, o) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o) + '\n'); }

async function main() {
  const i = process.argv.indexOf('--csv');
  let snap;
  if (i > -1 || !process.env.APPS_SCRIPT_URL) {
    const rows = i > -1 ? parseCsv(readFileSync(process.argv[i + 1], 'utf8')) : await readSheet();
    if (rows.length < 2) throw new Error('시트에 데이터가 없습니다.');
    snap = aggregate(rows, { profile: SVC });
  } else {
    snap = await fetchAppsScript();
  }

  // 안전장치: 개인 식별 필드가 결과에 섞이지 않았는지 확인
  const text = JSON.stringify(snap);
  if (/@[a-z0-9-]+\.[a-z]/i.test(text)) throw new Error('집계 결과에 이메일 형태 문자열이 포함되어 중단합니다.');

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) throw new Error('DASHBOARD_PASSWORD 환경 변수가 필요합니다.');
  const metaPath = join(DATA, 'meta.json');
  let key;
  if (existsSync(metaPath)) key = await openMeta(readJson(metaPath), password);
  else { const m = await createMeta(password); key = m.key; writeJson(metaPath, m.meta); }

  writeJson(join(OUT, 'snapshots', `${snap.week}.enc.json`), await encryptJson(key, snap));

  const idxPath = join(OUT, 'index.enc.json');
  const index = existsSync(idxPath) ? await decryptJson(key, readJson(idxPath)) : { snapshots: [] };
  index.snapshots = index.snapshots.filter((s) => s.week !== snap.week);
  index.snapshots.push(historyEntry(snap));
  index.snapshots.sort((a, b) => a.week.localeCompare(b.week));
  index.updatedAt = snap.generatedAt;
  writeJson(idxPath, await encryptJson(key, index));

  console.log(`${SVC_NAME} 스냅샷 ${snap.week} (${snap.weekStart}~${snap.weekEnd}) 생성: 총 ${snap.kpi.total.toLocaleString()}명, 주간 신규 ${snap.kpi.newWeek}명`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
