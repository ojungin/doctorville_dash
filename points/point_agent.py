#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
닥터빌 포인트 대시보드 — 로컬 에이전트

  포인트 Raw CSV(개인정보 포함)는 이 PC 밖으로 나가지 않습니다.
  이 스크립트가 PC 안에서 CSV를 읽어 SQLite에 누적하고, 집계치만 대시보드 비밀번호로
  암호화해 docs/data/points.enc.json 으로 게시합니다.

  사용법 (Windows: 같은 폴더의 .bat 파일을 더블클릭해도 됩니다)
    python point_agent.py serve     갱신 서버 실행 → 대시보드 [포인트] 탭의 [갱신] 버튼과 연동 (기본)
    python point_agent.py refresh   서버 없이 한 번만 갱신 (비밀번호 입력)
    python point_agent.py inspect   각 CSV의 컬럼명·인식 결과만 출력 (값은 출력하지 않음)
    python point_agent.py status    적재된 파일 목록 출력
    python point_agent.py export --from 2026-03 --to 2026-08   Excel 추출 (최대 6개월, 회원 USN 포함)

  신규 파일 판단: 파일명 + 파일 크기. 이미 적재한 파일은 건너뛰고 새 파일만 읽습니다.
  같은 거래가 여러 파일에 겹쳐 있어도 (USN, 일시, 금액, 내용) 기준으로 한 번만 저장됩니다.

  필요 패키지: cryptography   (설치: python -m pip install cryptography)
"""
import argparse
import zipfile
import io
import base64
import csv
import datetime as dt
import getpass
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import ssl
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# 사내 보안 프로그램(SSL 검사)의 인증서가 Python 3.13+의 엄격 검사(AKI 누락 등)에 걸리는 경우 대비:
# 인증서 체인·호스트 검증은 그대로 유지하고 X509 '엄격' 플래그만 해제한다.
SSL_CTX = ssl.create_default_context()
if hasattr(ssl, "VERIFY_X509_STRICT"):
    SSL_CTX.verify_flags &= ~ssl.VERIFY_X509_STRICT

VERSION = "1.3.0"
HERE = os.path.dirname(os.path.abspath(__file__))
KST = dt.timezone(dt.timedelta(hours=9))

try:
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass

# --------------------------------------------------------------------------------------
# 설정 (같은 폴더의 config.json 으로 덮어쓸 수 있습니다)
# --------------------------------------------------------------------------------------
DEFAULTS = {
    "raw_dir": os.path.dirname(HERE),                      # 포인트Raw 폴더 (이 폴더의 상위)
    "db_path": os.path.join(HERE, "data", "points.sqlite"),  # 누적 저장소 (개인정보 포함 — 외부 공유 금지)
    "out_path": os.path.join(HERE, "publish", "points.enc.json"),
    "repo_dir": "",                                          # doctorville_dash 로컬 클론 경로(선택)
    "git_push": True,                                        # repo_dir 사용 시 git commit/push
    "meta_url": "https://ojungin.github.io/doctorville_dash/data/meta.json",
    "github": {"token": "", "repo": "ojungin/doctorville_dash", "branch": "main",
               "path": "docs/data/points.enc.json"},
    "port": 8765,
    "allowed_origins": ["https://ojungin.github.io", "http://localhost:8000", "http://127.0.0.1:8000"],
    "big_earn_threshold": 100000,   # 건당 이 값을 '초과'하는 적립 = 이상치
    "repeat_buy_min": 10,           # 개인 월 구매 횟수가 이 값 '이상' = 이상치
    "earn_user_thresholds": [100000, 200000],
    "list_limit": 300,              # 이상치 목록 최대 표시 건수
    "export_max_months": 6,         # Excel 추출 최대 기간(개월)
}


def load_config():
    cfg = json.loads(json.dumps(DEFAULTS))
    p = os.path.join(HERE, "config.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8-sig") as f:
            user = json.load(f)
        for k, v in user.items():
            if k.startswith("_") or v == "":
                continue
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    for k in ("raw_dir", "db_path", "out_path", "repo_dir"):
        if cfg.get(k):
            cfg[k] = os.path.abspath(os.path.expanduser(cfg[k]))
    tok = os.environ.get("DV_GITHUB_TOKEN")
    if tok:
        cfg["github"]["token"] = tok
    return cfg


def log(*a):
    print(dt.datetime.now().strftime("[%H:%M:%S]"), *a, flush=True)


# --------------------------------------------------------------------------------------
# 적립·사용 방법 분류 (내용 텍스트 → 카테고리). 규칙을 바꾸면 다음 갱신 때 전체에 다시 적용됩니다.
# --------------------------------------------------------------------------------------
def norm_content(s):
    s = s or ""
    s = re.sub(r"\s*[\(\[].*?[\)\]]", "", s)   # (5014), [공지] 등 제거
    s = re.sub(r"\d+", "", s)
    s = re.sub(r"\s+", " ", s).strip(" /-_")
    return s


EARN_RULES = [  # (정규식, 카테고리) — 위에서부터 먼저 맞는 규칙 적용
    (r"테스트", "테스트·조정"),
    (r"이관|조정|회수", "테스트·조정"),
    (r"세미나.*설문|세미나설문|증례", "세미나 설문"),
    (r"출석", "출석체크"),
    (r"퀴즈|Q&A|문제", "퀴즈·이벤트 참여"),
    (r"생일", "생일 포인트"),
    (r"인증", "회원 인증"),
    (r"추천|초대", "추천·초대"),
    (r"설문|만족도|리워드|자문", "기타 설문·리워드"),
    (r"이벤트|가입|유입|커뮤니티|활동", "이벤트·활동"),
]
USE_RULES = [
    (r"소멸", "포인트 소멸"),
    (r"테스트|회수", "테스트·조정"),
    (r"네이버", "네이버포인트 전환"),
    (r"(?i)payco|페이코", "Payco 전환"),
    (r"비즈마켓", "비즈마켓"),
    (r"하늘맛", "하늘맛"),
    (r"제로샵", "제로샵"),
    (r"호텔", "호텔패스"),
    (r"기프티콘|포인트 결제", "기프티콘"),
    (r"아카데미|컨텐츠|콘텐츠", "아카데미 콘텐츠"),
]
# '반복 구매' 검출 대상 사용처 (전환·소멸 제외)
BUY_CATS = {"비즈마켓", "기프티콘", "하늘맛", "제로샵", "호텔패스", "아카데미 콘텐츠", "기타 사용"}
CANCEL_RE = re.compile(r"취소|환불")


def classify(content, positive):
    """→ (kind, category). kind: earn | cancel | use | expire"""
    n = norm_content(content)
    if positive:
        if CANCEL_RE.search(n):
            return "cancel", "결제 취소·환불"
        for rx, c in EARN_RULES:
            if re.search(rx, n):
                return "earn", c
        return "earn", "기타 적립"
    for rx, c in USE_RULES:
        if re.search(rx, n):
            return ("expire" if c == "포인트 소멸" else "use"), c
    return "use", "기타 사용"


# --------------------------------------------------------------------------------------
# CSV 읽기 (컬럼 자동 인식)
# --------------------------------------------------------------------------------------
def _n(h):
    return re.sub(r"[\s\"'﻿_\-\.()]", "", str(h)).lower()


ALIASES = {
    "usn": ["USN", "회원USN", "회원번호", "회원No", "회원ID", "회원아이디", "아이디", "ID", "user_id", "userid",
            "member_id", "mem_no", "memno", "usr_no"],
    "ts": ["날짜", "일시", "일자", "등록일", "등록일시", "적립일", "적립일시", "사용일", "사용일시", "거래일시",
           "발생일시", "처리일시", "변동일시", "created_at", "createdat", "reg_date", "regdate", "reg_dt", "date", "datetime"],
    "type": ["포인트 증감 구분", "증감구분", "증감 구분", "구분", "유형", "적립구분", "타입", "type", "point_type", "use_ty"],
    "content": ["내용", "처리내용", "사유", "적립사유", "사용사유", "사용처", "상세", "상세내용", "비고", "content", "memo",
                "description", "reason", "title"],
    "amt": ["적립 포인트", "적립포인트", "포인트", "증감 포인트", "증감포인트", "포인트금액", "금액", "변동포인트",
            "point", "points", "amount"],
    "use": ["사용 포인트", "사용포인트", "차감포인트", "차감 포인트", "use_point"],
    "chg": ["충전 포인트", "충전포인트", "charge_point", "chargepoint"],
}


def detect_encoding(path):
    with open(path, "rb") as f:
        head = f.read(1 << 16)
    if head.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    try:
        head.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError as e:
        if e.start > len(head) - 4:   # 버퍼 끝에서 잘린 멀티바이트
            return "utf-8"
        return "cp949"


def map_columns(header):
    nh = [_n(h) for h in header]
    col = {}
    for key, names in ALIASES.items():
        for name in names:
            nn = _n(name)
            if nn in nh and nh.index(nn) not in col.values():
                col[key] = nh.index(nn)
                break
    return col


CLEAN_RE = re.compile(r'^[=\s"\']+|[\s"\']+$')
DIGITS_RE = re.compile(r"\d+")


def clean(v):
    return CLEAN_RE.sub("", v) if v else ""


def parse_ts(v):
    v = clean(v)
    p = DIGITS_RE.findall(v)
    if not p:
        return None
    if len(p) == 1 and len(p[0]) >= 8:     # 20230105 / 20230105123000
        s = p[0]
        p = [s[0:4], s[4:6], s[6:8], s[8:10] or "0", s[10:12] or "0", s[12:14] or "0"]
    if len(p) < 3 or len(p[0]) != 4:
        return None
    y, m, d = int(p[0]), int(p[1]), int(p[2])
    H = int(p[3]) if len(p) > 3 else 0
    M = int(p[4]) if len(p) > 4 else 0
    S = int(p[5][:2]) if len(p) > 5 else 0
    if ("오후" in v or "PM" in v.upper()) and H < 12:
        H += 12
    if not (2000 <= y <= 2100 and 1 <= m <= 12 and 1 <= d <= 31):
        return None
    return "%04d-%02d-%02d %02d:%02d:%02d" % (y, m, d, H, M, S)


def parse_num(v):
    v = clean(v).replace(",", "")
    if not v or v == "-":
        return 0.0
    try:
        return float(v)
    except ValueError:
        return None


USE_WORDS = re.compile(r"사용|차감|소멸|회수|전환|결제")
# 구→신 시스템 이관(2025-04-19) 시 잔액을 옮겨 적은 행. 2015년부터 원장을 모두 적재하므로
# 이 행까지 넣으면 적립·잔여가 이중 계산된다 → 적재 제외
MIGRATION_RE = re.compile(r"포인트\s*이관")


def iter_rows(path):
    """(usn, ts, amt, chg, content) 를 돌려줍니다. amt: 적립 포인트 증감(+/-), chg: 충전 포인트 증감(+/-)"""
    enc = detect_encoding(path)
    with open(path, encoding=enc, errors="replace", newline="") as f:
        rd = csv.reader(f)
        header = next(rd)
        col = map_columns(header)
        need = ["usn", "ts"]
        miss = [k for k in need if k not in col] + ([] if ("amt" in col or "use" in col) else ["amt"])
        if miss:
            raise ValueError("컬럼을 인식하지 못했습니다: %s / 파일 컬럼: %s" % (miss, header))
        iu, it, ia, iuse = col["usn"], col["ts"], col.get("amt"), col.get("use")
        ity, ic = col.get("type"), col.get("content")
        ichg = col.get("chg")
        bad = 0
        mig = 0
        for row in rd:
            if not row:
                continue
            try:
                usn = clean(row[iu])
                ts = parse_ts(row[it])
                typ = clean(row[ity]) if ity is not None else ""
                content = clean(row[ic]) if ic is not None else typ
                if iuse is not None:
                    e = parse_num(row[ia]) if ia is not None else 0.0
                    u = parse_num(row[iuse])
                    if e is None or u is None:
                        raise ValueError
                    amt = e if e else -abs(u)
                else:
                    amt = parse_num(row[ia])
                    if amt is None:
                        raise ValueError
                    # 부호 없는 형식: 구분이 사용·차감·소멸이면 음수 처리 (사용취소는 양수)
                    if amt > 0 and typ and USE_WORDS.search(typ) and "취소" not in typ and "적립" not in typ:
                        amt = -amt
                chg = 0.0
                if ichg is not None and ichg < len(row):
                    chg = parse_num(row[ichg]) or 0.0
                    if chg > 0 and typ and USE_WORDS.search(typ) and "취소" not in typ and "적립" not in typ and "충전" not in typ:
                        chg = -chg
            except (IndexError, ValueError):
                bad += 1
                continue
            if MIGRATION_RE.search(content or typ):
                mig += 1
                continue
            if not usn or not ts or (amt == 0 and chg == 0):
                bad += 1
                continue
            yield usn, ts, round(amt, 2), round(chg, 2), content or "(내용 없음)"
        if mig:
            log("  · 시스템 이관 행 %d건 제외 (이중 계산 방지)" % mig)
        if bad:
            log("  · 인식 불가/0포인트 행 %d건 제외" % bad)


# --------------------------------------------------------------------------------------
# 저장소 (SQLite)
# --------------------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY, size INTEGER, mtime REAL, rows INTEGER,
  inserted INTEGER, dmin TEXT, dmax TEXT, loaded_at TEXT);
CREATE TABLE IF NOT EXISTS contents(cid INTEGER PRIMARY KEY, text TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS tx(usn TEXT, ts TEXT, amt REAL, cid INTEGER, seq INTEGER, chg REAL NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS tx_key2 ON tx(usn, ts, amt, chg, cid, seq);
CREATE TABLE IF NOT EXISTS info(k TEXT PRIMARY KEY, v TEXT);
"""
SCHEMA_VERSION = 2   # v2: 충전 포인트(chg) 컬럼 추가


def open_db(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path, timeout=60)
    db.executescript("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;"
                     "PRAGMA cache_size=-200000;")
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tx'").fetchone():
        db.executescript(SCHEMA)
        db.execute("INSERT OR REPLACE INTO info VALUES ('schema', ?)", (str(SCHEMA_VERSION),))
        db.commit()
    else:
        db.execute("CREATE TABLE IF NOT EXISTS info(k TEXT PRIMARY KEY, v TEXT)")
    return db


def schema_of(db):
    r = db.execute("SELECT v FROM info WHERE k='schema'").fetchone()
    return int(r[0]) if r else 1


def _info(db, k, default=None):
    r = db.execute("SELECT v FROM info WHERE k=?", (k,)).fetchone()
    return r[0] if r else default


def migrate_file(db, name, path):
    """스키마 1(충전 포인트 없음)로 적재한 파일을 다시 읽어 충전 포인트만 보강한다.
    적립 포인트가 있는 행은 기존 행의 chg 를 채우고, 충전 포인트만 있는 행은 새로 넣는다.
    순번(seq)은 최초 적재와 같은 방식으로 다시 계산해 기존 행과 정확히 맞춘다."""
    cids = dict(db.execute("SELECT text, cid FROM contents"))
    seqs, seqs0 = {}, {}
    upd, ins = [], []
    for usn, ts, amt, chg, content in iter_rows(path):
        cid = cids.get(content)
        if cid is None:
            cur = db.execute("INSERT OR IGNORE INTO contents(text) VALUES (?)", (content,))
            cid = cur.lastrowid if cur.rowcount else db.execute("SELECT cid FROM contents WHERE text=?", (content,)).fetchone()[0]
            cids[content] = cid
        if amt != 0:
            k = (usn, ts, amt, cid)
            sq = seqs.get(k, 0)
            seqs[k] = sq + 1
            if len(seqs) > 400000:
                seqs.clear()
            if chg:
                upd.append((chg, usn, ts, amt, cid, sq))
        else:
            k = (usn, ts, cid)
            sq = seqs0.get(k, 0)
            seqs0[k] = sq + 1
            ins.append((usn, ts, 0.0, cid, sq, chg))
    db.executemany("UPDATE tx SET chg=? WHERE usn=? AND ts=? AND amt=? AND cid=? AND seq=?", upd)
    before = db.total_changes
    db.executemany("INSERT OR IGNORE INTO tx(usn, ts, amt, cid, seq, chg) VALUES (?,?,?,?,?,?)", ins)
    done = set(json.loads(_info(db, "migrated_files", "[]")))
    done.add(name)
    db.execute("INSERT OR REPLACE INTO info VALUES ('migrated_files', ?)", (json.dumps(sorted(done), ensure_ascii=False),))
    db.commit()
    return len(upd), db.total_changes - before


def migrate_if_needed(cfg, db):
    """구버전 DB(충전 포인트 없음)면 chg 열을 추가하고, 이미 적재한 CSV에서 충전 포인트만 보강한다.
    (DB를 새로 만들지 않으므로 추가 디스크 공간이 거의 필요 없고, 중간에 끊겨도 이어서 진행)"""
    if schema_of(db) >= SCHEMA_VERSION:
        return db
    if "chg" not in [r[1] for r in db.execute("PRAGMA table_info(tx)")]:
        db.execute("ALTER TABLE tx ADD COLUMN chg REAL NOT NULL DEFAULT 0")
    db.execute("INSERT OR REPLACE INTO info VALUES ('seqkey', 'v1')")   # 기존 고유키(usn,ts,amt,cid,seq) 유지
    db.commit()
    loaded = {r[0]: r[1] for r in db.execute("SELECT name, size FROM files")}
    done = set(json.loads(_info(db, "migrated_files", "[]")))
    todo = [f for f in list_csv(cfg["raw_dir"]) if loaded.get(f[0]) == f[2] and f[0] not in done]
    log("DB 구조 변경: 충전 포인트 보강 — 적재된 파일 %d개를 다시 읽습니다 (최초 1회)" % len(todo))
    PROGRESS.update(stage="migrate", fileCount=len(todo), fileIndex=0)
    for i, (name, path, size, mtime) in enumerate(todo, 1):
        PROGRESS.update(fileIndex=i, file=name)
        t0 = time.time()
        try:
            u, n = migrate_file(db, name, path)
            log("  [%d/%d] %s · 충전 포인트 보강 %s행 / 충전만 있는 행 %s건 추가 · %.0f초" % (
                i, len(todo), name, format(u, ","), format(n, ","), time.time() - t0))
        except Exception as e:
            db.rollback()
            log("  ! 보강 실패: %s — %s" % (name, e))
            FAILED.append({"name": name, "error": "충전 포인트 보강 실패: " + str(e)[:250]})
            return db
    db.execute("INSERT OR REPLACE INTO info VALUES ('schema', ?)", (str(SCHEMA_VERSION),))
    db.commit()
    log("충전 포인트 보강 완료")
    return db


def list_csv(raw_dir):
    out = []
    for name in sorted(os.listdir(raw_dir)):
        p = os.path.join(raw_dir, name)
        if os.path.isfile(p) and name.lower().endswith(".csv") and not name.startswith("~$"):
            st = os.stat(p)
            out.append((name, p, st.st_size, st.st_mtime))
    return out


def pending_files(db, raw_dir):
    known = {r[0]: r[1] for r in db.execute("SELECT name, size FROM files")}
    return [f for f in list_csv(raw_dir) if known.get(f[0]) != f[2]]


FAILED = []
PROGRESS = {"running": False, "file": "", "rows": 0, "fileIndex": 0, "fileCount": 0, "stage": ""}


def load_file(db, name, path, size, mtime):
    cids = dict(db.execute("SELECT text, cid FROM contents"))
    v1key = _info(db, "seqkey") == "v1"     # 이전 구조에서 보강한 DB: 고유키에 chg 없음
    seqs = {}
    rows = 0
    before = db.execute("SELECT COUNT(*) FROM tx").fetchone()[0]
    dmin, dmax = None, None
    batch = []
    t0 = time.time()

    def flush():
        db.executemany("INSERT OR IGNORE INTO tx(usn, ts, amt, cid, seq, chg) VALUES (?,?,?,?,?,?)", batch)
        batch.clear()

    for usn, ts, amt, chg, content in iter_rows(path):
        cid = cids.get(content)
        if cid is None:
            cur = db.execute("INSERT OR IGNORE INTO contents(text) VALUES (?)", (content,))
            cid = cur.lastrowid if cur.rowcount else db.execute(
                "SELECT cid FROM contents WHERE text=?", (content,)).fetchone()[0]
            cids[content] = cid
        k = (usn, ts, amt, cid) if v1key else (usn, ts, amt, chg, cid)
        s = seqs.get(k, 0)
        seqs[k] = s + 1
        if len(seqs) > 400000:
            seqs.clear()
        batch.append((usn, ts, amt, cid, s, chg))
        rows += 1
        if dmin is None or ts < dmin:
            dmin = ts
        if dmax is None or ts > dmax:
            dmax = ts
        if len(batch) >= 50000:
            flush()
            PROGRESS["rows"] = rows
            if rows % 500000 == 0:
                log("  · %s행 처리 (%.0f초)" % (format(rows, ","), time.time() - t0))
    flush()
    inserted = db.execute("SELECT COUNT(*) FROM tx").fetchone()[0] - before
    now = dt.datetime.now(KST).strftime("%Y-%m-%d %H:%M")
    db.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?,?)",
               (name, size, mtime, rows, inserted, dmin, dmax, now))
    db.commit()
    log("  · 완료: %s행 읽음 / 신규 %s행 저장 (중복 %s행) · %s ~ %s · %.0f초" % (
        format(rows, ","), format(inserted, ","), format(rows - inserted, ","), dmin, dmax, time.time() - t0))
    return {"name": name, "rows": rows, "inserted": inserted, "dmin": dmin, "dmax": dmax}


def ingest(db, raw_dir):
    todo = pending_files(db, raw_dir)
    PROGRESS.update(fileCount=len(todo), fileIndex=0)
    loaded = []
    if not todo:
        log("신규 파일이 없습니다.")
    for i, (name, path, size, mtime) in enumerate(todo, 1):
        PROGRESS.update(file=name, fileIndex=i, rows=0, stage="load")
        log("[%d/%d] 적재: %s (%.0f MB)" % (i, len(todo), name, size / 1e6))
        try:
            loaded.append(load_file(db, name, path, size, mtime))
        except Exception as e:           # 형식을 모르는 파일은 건너뛰고 나머지를 계속 적재
            db.rollback()
            log("  ! 건너뜀: %s" % e)
            FAILED.append({"name": name, "error": str(e)[:300]})
    return loaded


# --------------------------------------------------------------------------------------
# 집계 → 대시보드용 JSON (개인정보: 이름 미포함, USN은 마스킹)
# --------------------------------------------------------------------------------------
def mask(usn):
    s = str(usn)
    if len(s) <= 3:
        return s[0] + "*" * (len(s) - 1)
    keep = 2 if len(s) >= 6 else 1
    return s[:keep] + "*" * (len(s) - keep * 2) + s[-keep:]


def month_range(a, b):
    y, m = int(a[:4]), int(a[5:7])
    out = []
    while "%04d-%02d" % (y, m) <= b:
        out.append("%04d-%02d" % (y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def aggregate(db, cfg):
    PROGRESS.update(stage="aggregate")
    log("집계 중…")
    t0 = time.time()
    # 분류표 (내용 × 부호)
    db.execute("DROP TABLE IF EXISTS temp.cat")
    db.execute("CREATE TEMP TABLE cat(cid INTEGER, pos INTEGER, kind TEXT, cat TEXT, buy INTEGER, PRIMARY KEY(cid,pos))")
    rows = []
    for cid, text in db.execute("SELECT cid, text FROM contents"):
        for pos in (1, 0):
            kind, c = classify(text, bool(pos))
            if MIGRATION_RE.search(text or ""):      # 시스템 이관(적립·충전 포인트 이관) → 통계 제외
                kind, c = "skip", "시스템 이관"
            rows.append((cid, pos, kind, c, 1 if (kind == "use" and c in BUY_CATS) else 0))
    db.executemany("INSERT INTO temp.cat VALUES (?,?,?,?,?)", rows)
    J = "FROM tx JOIN temp.cat c ON c.cid = tx.cid AND c.pos = (tx.amt > 0) AND tx.amt != 0"
    # 회원·월·내용 단위 요약 (원장 1회 스캔) — 이후 집계는 요약표에서 계산
    db.execute("DROP TABLE IF EXISTS temp.s")
    db.execute("CREATE TEMP TABLE s AS SELECT substr(tx.ts,1,7) ym, tx.usn usn, tx.cid cid, (tx.amt > 0) pos, "
               "SUM(tx.amt) a, COUNT(*) n %s WHERE c.kind != 'skip' GROUP BY 1,2,3,4" % J)
    S = "FROM temp.s t JOIN temp.cat c ON c.cid = t.cid AND c.pos = t.pos"

    r1 = db.execute("SELECT MIN(dmin), MAX(dmax) FROM files").fetchone()
    r2 = db.execute("SELECT SUM(n), COUNT(DISTINCT usn), MIN(ym), MAX(ym) FROM temp.s").fetchone()
    if not r2[0]:
        raise RuntimeError("적재된 데이터가 없습니다.")
    rng = (r1[0] or r2[2] + "-01", r1[1] or r2[3] + "-28", r2[0], r2[1])
    months = month_range(rng[0][:7], rng[1][:7])
    mi = {m: i for i, m in enumerate(months)}
    N = len(months)
    z = lambda: [0] * N

    # 1·2·5·6) 월 × 분류 합계
    kinds = {k: {"amt": z(), "cnt": z()} for k in ("earn", "cancel", "use", "expire")}
    methods = {"earn": {}, "use": {}, "expire": {}, "cancel": {}}
    for ym, kind, c, s, n in db.execute(
            "SELECT ym, c.kind, c.cat, SUM(a), SUM(n) %s GROUP BY 1,2,3" % S):
        i = mi[ym]
        a = abs(s)
        kinds[kind]["amt"][i] += a
        kinds[kind]["cnt"][i] += n
        m = methods[kind].setdefault(c, {"amt": z(), "cnt": z()})
        m["amt"][i] += a
        m["cnt"][i] += n
    # 월별 이용자 수 (1인당 평균용)
    users = {"earn": z(), "use": z()}
    for ym, kind, u in db.execute(
            "SELECT ym, c.kind, COUNT(DISTINCT usn) %s WHERE c.kind IN ('earn','use') GROUP BY 1,2" % S):
        users[kind][mi[ym]] = u
    # 방법별 월 이용자 수
    for ym, kind, c, u in db.execute(
            "SELECT ym, c.kind, c.cat, COUNT(DISTINCT usn) %s WHERE c.kind IN ('earn','use') GROUP BY 1,2,3" % S):
        methods[kind][c].setdefault("users", z())[mi[ym]] = u
    for k in ("earn", "use"):
        for m in methods[k].values():
            m.setdefault("users", z())

    # 3) 잔여 포인트 (데이터 시작 시점 잔액 0 가정, 적립+취소-사용-소멸 누적)
    net = [kinds["earn"]["amt"][i] + kinds["cancel"]["amt"][i] - kinds["use"]["amt"][i] - kinds["expire"]["amt"][i]
           for i in range(N)]
    bal, acc = [], 0
    for v in net:
        acc += v
        bal.append(round(acc))
    # 월말 잔여 보유 회원 수는 비용이 커서 생략. 현재 잔여 보유자 분포:
    holders = {"over0": 0, "over10k": 0, "over50k": 0, "over100k": 0}
    for (b,) in db.execute("SELECT SUM(a) FROM temp.s GROUP BY usn"):
        if b > 0:
            holders["over0"] += 1
        if b >= 10000:
            holders["over10k"] += 1
        if b >= 50000:
            holders["over50k"] += 1
        if b >= 100000:
            holders["over100k"] += 1

    # 4) 잔여 포인트 기준 인원수 — 회원별 월말 잔여(누적 적립+취소−사용−소멸)가 기준 이상인 회원 수
    ths = cfg["earn_user_thresholds"]
    lv = [0] + list(ths)                         # 0 = 잔여 보유(>0)
    diff = [[0] * (N + 1) for _ in lv]

    def _mark(i0, i1, b):
        if i1 <= i0:
            return
        for j, t in enumerate(lv):
            if (b > 0) if t == 0 else (b >= t):
                diff[j][i0] += 1
                diff[j][i1] -= 1
    cu, bal_u, pi = None, 0.0, None
    for usn, ym, a in db.execute("SELECT usn, ym, SUM(a) FROM temp.s GROUP BY usn, ym ORDER BY usn, ym"):
        i = mi[ym]
        if usn != cu:
            if cu is not None:
                _mark(pi, N, bal_u)
            cu, bal_u = usn, 0.0
        else:
            _mark(pi, i, bal_u)
        bal_u += a
        pi = i
    if cu is not None:
        _mark(pi, N, bal_u)
    lvm = []
    for j in range(len(lv)):
        acc, row = 0, []
        for i in range(N):
            acc += diff[j][i]
            row.append(acc)
        lvm.append(row)
    per_year = {}
    for i, m in enumerate(months):
        per_year[m[:4]] = i                     # 연말(진행 중 연도는 마지막 달) 인덱스
    by_year = {y: {"asOf": months[i], "holders": lvm[0][i], "counts": [lvm[j + 1][i] for j in range(len(ths))]}
               for y, i in per_year.items()}

    # 4-2) 작년 대비 월별 적립·사용 (현재 = 데이터 마지막 날짜 기준)
    asof = rng[1][:10]
    ty, ly = int(asof[:4]), int(asof[:4]) - 1
    md = asof[5:10]
    nxt = dt.date(ty + (asof[5:7] == "12"), int(asof[5:7]) % 12 + 1, 1)
    partial = (nxt - dt.timedelta(days=1)).isoformat() != asof
    def _series(year, arr, upto=None):
        out = []
        for mm in range(1, 13):
            k = "%04d-%02d" % (year, mm)
            out.append(None if (k not in mi or (upto and k > upto)) else round(abs(arr[mi[k]])))
        return out
    ytd = {}
    if not partial:   # 월말 기준이면 요약표로 계산 (원장 재스캔 생략)
        q = ("SELECT substr(ym,1,4), c.kind, SUM(a), COUNT(DISTINCT usn) %s WHERE c.kind IN ('earn','use') "
             "AND ((ym >= ? AND ym <= ?) OR (ym >= ? AND ym <= ?)) GROUP BY 1,2" % S)
        prm = ("%d-01" % ly, "%d-%s" % (ly, asof[5:7]), "%d-01" % ty, asof[:7])
    else:
        q = ("SELECT substr(tx.ts,1,4), c.kind, SUM(tx.amt), COUNT(DISTINCT tx.usn) %s WHERE c.kind IN ('earn','use') "
             "AND ((tx.ts >= ? AND tx.ts <= ?) OR (tx.ts >= ? AND tx.ts <= ?)) GROUP BY 1,2" % J)
        prm = ("%d-01-01" % ly, "%d-%s 23:59:59" % (ly, md), "%d-01-01" % ty, asof + " 23:59:59")
    for y, kind, sm, u in db.execute(q, prm):
        ytd[(int(y), kind)] = (round(abs(sm or 0)), u)
    tot_users = dict(db.execute(
        "SELECT c.kind, COUNT(DISTINCT usn) %s WHERE c.kind IN ('earn','use') AND ym BETWEEN ? AND ? GROUP BY 1" % S,
        ("%d-01" % ly, "%d-12" % ly)).fetchall())
    yoy = {"asOf": asof, "thisYear": ty, "lastYear": ly, "currentMonth": int(asof[5:7]), "partial": partial}
    for k in ("earn", "use"):
        la = _series(ly, kinds[k]["amt"])
        yoy[k] = {
            "amt": {"cur": _series(ty, kinds[k]["amt"], asof[:7]), "last": la,
                    "ytdCur": ytd.get((ty, k), (0, 0))[0], "ytdLast": ytd.get((ly, k), (0, 0))[0],
                    "totalLast": sum(v for v in la if v)},
            "users": {"cur": _series(ty, users[k], asof[:7]), "last": _series(ly, users[k]),
                      "ytdCur": ytd.get((ty, k), (0, 0))[1], "ytdLast": ytd.get((ly, k), (0, 0))[1],
                      "totalLast": tot_users.get(k, 0)},
        }

    # 8-1) 건당 고액 적립
    big = cfg["big_earn_threshold"]
    big_m = z()
    big_amt_m = z()
    for ym, n, s in db.execute(
            "SELECT substr(ts,1,7), COUNT(*), SUM(amt) %s WHERE c.kind='earn' AND amt > ? GROUP BY 1" % J, (big,)):
        big_m[mi[ym]] = n
        big_amt_m[mi[ym]] = s
    big_list = [{"id": mask(u), "ts": ts[:16], "amt": round(a), "cat": c, "text": t[:60]} for u, ts, a, c, t in db.execute(
        "SELECT usn, ts, amt, c.cat, ct.text %s JOIN contents ct ON ct.cid = tx.cid "
        "WHERE c.kind='earn' AND amt > ? ORDER BY ts DESC LIMIT ?" % J, (big, cfg["list_limit"]))]
    big_by_cat = {}
    for c, n, s in db.execute("SELECT c.cat, COUNT(*), SUM(amt) %s WHERE c.kind='earn' AND amt > ? GROUP BY 1" % J, (big,)):
        big_by_cat[c] = {"cnt": n, "amt": round(s)}

    # 8-2) 개인 월 반복 구매
    rb = cfg["repeat_buy_min"]
    db.execute("DROP TABLE IF EXISTS temp.rep")
    db.execute("CREATE TEMP TABLE rep AS SELECT ym, usn, SUM(n) n, -SUM(a) s %s "
               "WHERE c.kind='use' AND c.buy=1 GROUP BY 1,2 HAVING SUM(n) >= ?" % S, (rb,))
    rep_m, rep_amt_m = z(), z()
    for ym, n, s in db.execute("SELECT ym, COUNT(*), SUM(s) FROM temp.rep GROUP BY 1"):
        rep_m[mi[ym]] = n
        rep_amt_m[mi[ym]] = s
    rep_rows = db.execute("SELECT ym, usn, n, s FROM temp.rep ORDER BY ym DESC, n DESC LIMIT ?",
                          (cfg["list_limit"],)).fetchall()
    top_cat = {}
    if rep_rows:
        db.execute("CREATE TEMP TABLE IF NOT EXISTS rsel(ym TEXT, usn TEXT)")
        db.execute("DELETE FROM temp.rsel")
        db.executemany("INSERT INTO temp.rsel VALUES (?,?)", [(r[0], r[1]) for r in rep_rows])
        for ym, usn, c, n in db.execute(
                "SELECT t.ym, t.usn, c.cat, SUM(t.n) %s JOIN temp.rsel r ON r.usn = t.usn "
                "AND r.ym = t.ym WHERE c.kind='use' AND c.buy=1 GROUP BY 1,2,3" % S):
            k = (ym, usn)
            if k not in top_cat or n > top_cat[k][1]:
                top_cat[k] = (c, n)
    rep_list = [{"id": mask(u), "ym": ym, "cnt": n, "amt": round(s), "cat": top_cat.get((ym, u), ("", 0))[0]}
                for ym, u, n, s in rep_rows]
    rep_total = db.execute("SELECT COUNT(*), COUNT(DISTINCT usn) FROM temp.rep").fetchone()

    files = [dict(zip(("name", "rows", "inserted", "dmin", "dmax", "loadedAt"), r)) for r in db.execute(
        "SELECT name, rows, inserted, dmin, dmax, loaded_at FROM files ORDER BY dmin")]

    rnd = lambda arr: [round(v) for v in arr]
    out = {
        "v": 1,
        "generatedAtKst": dt.datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
        "range": {"from": rng[0][:10], "to": rng[1][:10], "tx": rng[2], "members": rng[3]},
        "months": months,
        "earn": {"amt": rnd(kinds["earn"]["amt"]), "cnt": kinds["earn"]["cnt"], "users": users["earn"]},
        "use": {"amt": rnd(kinds["use"]["amt"]), "cnt": kinds["use"]["cnt"], "users": users["use"]},
        "cancel": {"amt": rnd(kinds["cancel"]["amt"]), "cnt": kinds["cancel"]["cnt"]},
        "expire": {"amt": rnd(kinds["expire"]["amt"]), "cnt": kinds["expire"]["cnt"]},
        "balance": bal,
        "holders": holders,
        "methods": {k: {c: {"amt": rnd(m["amt"]), "cnt": m["cnt"], "users": m.get("users")} for c, m in v.items()}
                    for k, v in methods.items()},
        "thresholds": {"basis": "balance", "values": ths, "current": [lvm[j + 1][N - 1] for j in range(len(ths))],
                       "holders": lvm[0][N - 1], "byYear": by_year, "monthly": lvm[1:], "monthlyHolders": lvm[0]},
        "yoy": yoy,
        "anomaly": {
            "bigEarn": {"threshold": big, "monthly": big_m, "monthlyAmt": rnd(big_amt_m), "byCat": big_by_cat,
                        "total": sum(big_m), "list": big_list},
            "repeatBuy": {"min": rb, "monthly": rep_m, "monthlyAmt": rnd(rep_amt_m), "total": rep_total[0],
                          "members": rep_total[1], "cats": sorted(BUY_CATS), "list": rep_list},
        },
        "files": files,
        "rules": {"balance": "데이터 시작 시점 잔액 0 가정, 적립+사용취소-사용-소멸 누적", "excluded": "시스템 이관(적립·충전 포인트 이관) 행 제외",
                  "use": "사용 = 구매·전환 금액(결제 취소·환불은 별도 표시), 소멸 별도"},
    }
    log("집계 완료 (%.0f초) · 기간 %s ~ %s · 거래 %s건 · 회원 %s명" % (
        time.time() - t0, out["range"]["from"], out["range"]["to"], format(rng[2], ","), format(rng[3], ",")))
    return out


# --------------------------------------------------------------------------------------
# 암호화 (대시보드와 동일: PBKDF2-SHA256 + AES-256-GCM)
# --------------------------------------------------------------------------------------
def _aes():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        return AESGCM
    except ImportError:
        raise RuntimeError("cryptography 패키지가 필요합니다. 명령 프롬프트에서: python -m pip install cryptography")


_meta_cache = {}


def get_meta(cfg):
    if cfg.get("repo_dir"):
        p = os.path.join(cfg["repo_dir"], "docs", "data", "meta.json")
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    if "m" in _meta_cache and time.time() - _meta_cache["t"] < 600:
        return _meta_cache["m"]
    local = os.path.join(os.path.dirname(cfg["db_path"]), "meta.json")
    try:
        with urllib.request.urlopen(cfg["meta_url"] + "?t=%d" % time.time(), timeout=20, context=SSL_CTX) as r:
            m = json.loads(r.read().decode("utf-8"))
        try:
            with open(local, "w", encoding="utf-8") as f:
                json.dump(m, f)
        except Exception:
            pass
    except Exception as e:
        if not os.path.exists(local):
            raise
        log("meta.json 온라인 조회 실패(%s) → 로컬 사본 사용" % e)
        with open(local, encoding="utf-8") as f:
            m = json.load(f)
    _meta_cache.update(m=m, t=time.time())
    return m


_key_cache = {}


def derive_key(meta, password):
    ck = hashlib.sha256((meta["salt"] + "|" + password).encode()).hexdigest()
    if ck in _key_cache:
        return _key_cache[ck]
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), base64.b64decode(meta["salt"]), int(meta["iter"]), 32)
    AESGCM = _aes()
    try:
        box = meta["check"]
        AESGCM(key).decrypt(base64.b64decode(box["iv"]), base64.b64decode(box["ct"]), None)
    except Exception:
        raise PermissionError("비밀번호가 대시보드 비밀번호와 다릅니다.")
    _key_cache.clear()
    _key_cache[ck] = key
    return key


def encrypt_json(key, obj):
    AESGCM = _aes()
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), None)
    return {"v": 1, "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}


# --------------------------------------------------------------------------------------
# 게시
# --------------------------------------------------------------------------------------
def publish(cfg, box):
    text = json.dumps(box) + "\n"
    os.makedirs(os.path.dirname(cfg["out_path"]), exist_ok=True)
    with open(cfg["out_path"], "w", encoding="utf-8") as f:
        f.write(text)
    if cfg.get("repo_dir"):
        p = os.path.join(cfg["repo_dir"], "docs", "data", "points.enc.json")
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        if cfg.get("git_push"):
            try:
                g = lambda *a: subprocess.run(["git", "-C", cfg["repo_dir"]] + list(a), check=True,
                                              capture_output=True, text=True)
                g("add", "docs/data/points.enc.json")
                if subprocess.run(["git", "-C", cfg["repo_dir"], "diff", "--cached", "--quiet"]).returncode:
                    g("commit", "-m", "포인트 집계 갱신")
                g("push")
                return {"mode": "git", "message": "저장소에 게시했습니다 (git push)."}
            except Exception as e:
                return {"mode": "local", "message": "git push 실패: %s — %s 파일을 저장소에 올려 주세요." % (e, p)}
        return {"mode": "local", "message": "로컬 저장소에 저장했습니다. 커밋·푸시해 주세요: " + p}
    gh = cfg.get("github") or {}
    if gh.get("token"):
        try:
            api = "https://api.github.com/repos/%s/contents/%s" % (gh["repo"], gh["path"])
            hdr = {"Authorization": "Bearer " + gh["token"], "Accept": "application/vnd.github+json",
                   "User-Agent": "dv-point-agent"}
            sha = None
            try:
                with urllib.request.urlopen(urllib.request.Request(api + "?ref=" + gh["branch"], headers=hdr), timeout=30, context=SSL_CTX) as r:
                    sha = json.loads(r.read())["sha"]
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
            body = {"message": "포인트 집계 갱신", "branch": gh["branch"],
                    "content": base64.b64encode(text.encode()).decode()}
            if sha:
                body["sha"] = sha
            req = urllib.request.Request(api, data=json.dumps(body).encode(), headers=hdr, method="PUT")
            with urllib.request.urlopen(req, timeout=60, context=SSL_CTX):
                pass
            return {"mode": "github", "message": "GitHub에 게시했습니다. 1~2분 후 다른 PC에서도 보입니다."}
        except Exception as e:
            return {"mode": "local", "message": "GitHub 게시 실패(%s). %s 파일을 docs/data/ 에 올려 주세요." % (e, cfg["out_path"])}
    return {"mode": "local", "message": "게시 설정이 없어 PC에만 저장했습니다. 다른 사람도 보게 하려면 %s 파일을 "
                                         "저장소 docs/data/ 에 올려 주세요." % cfg["out_path"]}


# --------------------------------------------------------------------------------------
# Excel 추출 (외부 패키지 없이 xlsx 작성) — 회원 USN 포함: PC에서만 생성·다운로드, 게시하지 않음
# --------------------------------------------------------------------------------------
_XML_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _xesc(v):
    return _XML_BAD.sub("", str(v)).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _col(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


class XlsxSheet:
    # 스타일: 0 기본, 1 헤더, 2 숫자, 3 합계 숫자, 4 제목, 5 합계 문자, 6 줄바꿈 문자
    def __init__(self, name, widths=None, freeze=1, autofilter=True):
        self.name, self.widths, self.freeze, self.autofilter = name[:31], widths or [], freeze, autofilter
        self.rows, self.merges, self.ncol = [], [], 0

    def add(self, cells, style=None):
        """cells: 값 목록. 숫자는 숫자 칸, 그 외는 문자. style: 칸 공통 스타일 번호(없으면 자동)"""
        self.rows.append((cells, style))
        self.ncol = max(self.ncol, len(cells))

    def xml(self):
        out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
               'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">']
        if self.freeze:
            out.append('<sheetViews><sheetView workbookViewId="0"><pane ySplit="%d" topLeftCell="A%d" activePane="bottomLeft" '
                       'state="frozen"/></sheetView></sheetViews>' % (self.freeze, self.freeze + 1))
        if self.widths:
            out.append("<cols>" + "".join('<col min="%d" max="%d" width="%s" customWidth="1"/>' % (i + 1, i + 1, w)
                                          for i, w in enumerate(self.widths)) + "</cols>")
        out.append("<sheetData>")
        for r, (cells, style) in enumerate(self.rows, 1):
            cs = []
            for c, v in enumerate(cells):
                if v is None or v == "":
                    continue
                ref = _col(c) + str(r)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    st = style if style is not None else 2
                    if st == 5:
                        st = 3
                    cs.append('<c r="%s" s="%d"><v>%s</v></c>' % (ref, st, repr(round(v, 2)) if isinstance(v, float) else v))
                else:
                    st = style if style is not None else 0
                    if st in (2, 3):
                        st = 5 if st == 3 else 0
                    cs.append('<c r="%s" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, st, _xesc(v)))
            out.append('<row r="%d">%s</row>' % (r, "".join(cs)))
        out.append("</sheetData>")
        if self.autofilter and self.freeze and len(self.rows) > self.freeze:
            out.append('<autoFilter ref="A%d:%s%d"/>' % (self.freeze, _col(max(0, self.ncol - 1)), len(self.rows)))
        if self.merges:
            out.append('<mergeCells count="%d">%s</mergeCells>' % (len(self.merges), "".join('<mergeCell ref="%s"/>' % m for m in self.merges)))
        out.append("</worksheet>")
        return "".join(out)


_STYLES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
           '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>'
           '<fonts count="3"><font><sz val="10"/><name val="맑은 고딕"/></font>'
           '<font><b/><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="13"/><name val="맑은 고딕"/></font></fonts>'
           '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
           '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F2"/><bgColor indexed="64"/></patternFill></fill>'
           '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>'
           '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
           '<border><left/><right/><top/><bottom style="thin"><color rgb="FF9FB3CC"/></bottom><diagonal/></border></borders>'
           '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
           '<cellXfs count="7">'
           '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
           '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
           '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
           '<xf numFmtId="164" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>'
           '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
           '<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
           '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>'
           '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')


def build_xlsx(sheets):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   + "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1)
                             for i in range(len(sheets))) + "</Types>")
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                   "</Relationships>")
        z.writestr("xl/workbook.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (_xesc(sh.name), i + 1, i + 1) for i, sh in enumerate(sheets))
                   + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>' % (i + 1, i + 1)
                             for i in range(len(sheets)))
                   + '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' % (len(sheets) + 1)
                   + "</Relationships>")
        z.writestr("xl/styles.xml", _STYLES)
        for i, sh in enumerate(sheets):
            z.writestr("xl/worksheets/sheet%d.xml" % (i + 1), sh.xml())
    return buf.getvalue()


def item_name(text):
    """적립·사용 내용에서 괄호 안 내용을 빼고 명칭만 남긴다. 예) '세미나 설문 (2259)' → '세미나 설문'"""
    t = text or ""
    t = re.sub(r"\s*[\(\[（【［].*?[\)\]）】］]", "", t)
    t = re.sub(r"\s*[\(\[（【［].*$", "", t)          # 닫는 괄호가 없는 경우
    t = re.sub(r"\s+", " ", t).strip(" -_/")
    return t or (text or "").strip() or "(내용 없음)"


def _month_list(frm, to):
    y, m = int(frm[:4]), int(frm[5:7])
    out = []
    while "%04d-%02d" % (y, m) <= to:
        out.append("%04d-%02d" % (y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


EXPORT_LOCK = threading.Lock()


def export_xlsx(cfg, password, frm, to):
    derive_key(get_meta(cfg), password)                      # 대시보드 비밀번호 확인
    if not (re.fullmatch(r"\d{4}-\d{2}", frm or "") and re.fullmatch(r"\d{4}-\d{2}", to or "")):
        raise ValueError("기간 형식이 올바르지 않습니다 (YYYY-MM).")
    if frm > to:
        frm, to = to, frm
    months = _month_list(frm, to)
    mx = int(cfg.get("export_max_months") or 6)
    if len(months) > mx:
        raise ValueError("추출 기간은 최대 %d개월입니다 (선택: %d개월)." % (mx, len(months)))
    if not EXPORT_LOCK.acquire(blocking=False):
        raise RuntimeError("이미 추출이 진행 중입니다.")
    t0 = time.time()
    try:
        db = open_db(cfg["db_path"])
        try:
            if schema_of(db) < SCHEMA_VERSION:
                raise RuntimeError("충전 포인트 보강(최초 1회)이 아직 끝나지 않았습니다. 먼저 [갱신]을 눌러 주세요.")
            texts = dict(db.execute("SELECT cid, text FROM contents"))
            log("Excel 추출: %s ~ %s" % (frm, to))
            rows = db.execute(
                "SELECT usn, substr(ts,1,7), cid, "
                "SUM(CASE WHEN amt > 0 THEN amt ELSE 0 END), SUM(amt > 0), "
                "SUM(CASE WHEN amt < 0 THEN -amt ELSE 0 END), "
                "SUM(CASE WHEN chg < 0 THEN -chg ELSE 0 END), SUM(amt < 0 OR chg < 0), "
                "SUM(CASE WHEN chg > 0 THEN chg ELSE 0 END), SUM(chg > 0 AND amt <= 0) "
                "FROM tx WHERE ts >= ? AND ts < ? GROUP BY 1,2,3",
                (months[0] + "-01", months[-1] + "-32")).fetchall()
        finally:
            db.close()
        # 내용별 분류
        kinds = {}
        def kind_of(cid):
            k = kinds.get(cid)
            if k is None:
                t = texts.get(cid, "")
                mig = bool(MIGRATION_RE.search(t))
                kp = classify(t, True)[0]
                kn = classify(t, False)[0]
                k = kinds[cid] = (mig, kp, kn, item_name(t))
            return k
        # 회원별 월: [적립, 취소적립, 적립포인트 사용, 충전포인트 사용, 소멸, 충전포인트 충전·환원]
        per = {}
        earn_items, use_items = {}, {}
        for usn, ym, cid, ap, np_, an, cn, nn, cp, ncp in rows:
            mig, kp, kn, name = kind_of(cid)
            if mig:
                continue
            v = per.setdefault((usn, ym), [0.0] * 6)
            if ap:
                v[1 if kp == "cancel" else 0] += ap
                key = ("취소적립" if kp == "cancel" else "적립", name)
                d = earn_items.setdefault(key, {})
                e = d.setdefault(ym, [0.0, 0, set()])
                e[0] += ap; e[1] += np_; e[2].add(usn)
            if an or cn:
                if kn == "expire":
                    v[4] += an + cn
                else:
                    v[2] += an; v[3] += cn
                key = ("소멸" if kn == "expire" else "사용", name)
                d = use_items.setdefault(key, {})
                e = d.setdefault(ym, [0.0, 0.0, 0, set()])
                e[0] += an; e[1] += cn; e[2] += nn; e[3].add(usn)
            if cp:
                v[5] += cp
                key = ("충전포인트 충전·환원", name)
                d = earn_items.setdefault(key, {})
                e = d.setdefault(ym, [0.0, 0, set()])
                e[0] += cp; e[1] += ncp; e[2].add(usn)
        R = lambda x: int(round(x))
        now = dt.datetime.now(KST).strftime("%Y-%m-%d %H:%M")
        # 1) 안내
        info = XlsxSheet("안내", widths=[22, 100], freeze=0, autofilter=False)
        info.add(["닥터빌 포인트 Excel 추출"], 4)
        info.add([])
        for k, v in [
            ("추출 기간", "%s ~ %s (%d개월)" % (months[0], months[-1], len(months))),
            ("생성 시각", now + " KST · 에이전트 v" + VERSION),
            ("회원별_월별", "회원(USN)·월 단위 적립 / 사용 포인트"),
            ("회원별_기간합계", "회원(USN)별 추출 기간 합계"),
            ("적립_항목별_월 / 사용_항목별_월", "항목(괄호 안 내용을 뺀 명칭) × 월 금액 표"),
            ("적립_항목별_상세 / 사용_항목별_상세", "월·항목별 금액·건수·회원 수 (피벗·필터용)"),
            ("적립", "적립 포인트 중 사용취소·환불을 뺀 일반 적립"),
            ("취소적립", "결제 취소·환불로 되돌려 받은 적립 포인트"),
            ("적립포인트 사용", "구매·전환 등에 쓴 적립 포인트 (소멸 제외)"),
            ("충전포인트 사용", "구매·전환 등에 쓴 충전 포인트 (유료 충전분)"),
            ("참고 열", "소멸(유효기간 만료·탈퇴)과 충전포인트 충전·환원은 적립·사용 합계에 넣지 않고 따로 표시"),
            ("제외", "2025-04-19 시스템 이관 시 옮겨 적은 '적립 포인트 이관'·'충전 포인트 이관' 내역"),
            ("항목 명칭", "내용의 괄호 안 내용(회차·날짜·주문번호 등)을 제거해 같은 명칭끼리 합산. 예) 세미나 설문 (2259) → 세미나 설문"),
            ("회원 수", "해당 월(기간)에 그 항목으로 1회 이상 적립·사용한 회원 수 (중복 제외)"),
            ("개인정보 주의", "이 파일에는 회원 USN이 포함되어 있습니다. 사내 개인정보 처리 기준에 따라 보관하고, 외부 공유 전에는 반드시 사전 승인을 받으세요."),
        ]:
            info.add([k, v], None)
        for i in range(2, len(info.rows)):
            info.rows[i] = (info.rows[i][0], 6)
        # 2) 회원별 월별
        H = ["적립", "취소적립", "적립 합계", "적립포인트 사용", "충전포인트 사용", "사용 합계", "(참고) 소멸", "(참고) 충전포인트 충전·환원"]
        def vals(v):
            return [R(v[0]), R(v[1]), R(v[0] + v[1]), R(v[2]), R(v[3]), R(v[2] + v[3]), R(v[4]), R(v[5])]
        um = XlsxSheet("회원별_월별", widths=[14, 10] + [14] * 8)
        um.add(["USN", "월"] + H, 1)
        tot = [0.0] * 6
        users = {}
        for (usn, ym) in sorted(per, key=lambda k: (k[0].zfill(12), k[1])):
            v = per[(usn, ym)]
            um.add([usn, ym] + vals(v))
            u = users.setdefault(usn, [0.0] * 6 + [0])
            for i in range(6):
                u[i] += v[i]
                tot[i] += v[i]
            u[6] += 1
        um.add(["합계", "%d명" % len(users)] + vals(tot), 3)
        # 3) 회원별 기간합계
        ut = XlsxSheet("회원별_기간합계", widths=[14, 10] + [14] * 8)
        ut.add(["USN", "활동 월 수"] + H, 1)
        for usn in sorted(users, key=lambda u: u.zfill(12)):
            u = users[usn]
            ut.add([usn, u[6]] + vals(u))
        ut.add(["합계", len(users)] + vals(tot), 3)
        # 4·6) 적립 항목별
        order_e = {"적립": 0, "취소적립": 1, "충전포인트 충전·환원": 2}
        ek = sorted(earn_items, key=lambda k: (order_e.get(k[0], 9), -sum(e[0] for e in earn_items[k].values()), k[1]))
        ew = XlsxSheet("적립_항목별_월", widths=[18, 34] + [14] * len(months) + [15, 12, 12])
        ew.add(["구분", "항목"] + ["%s 금액" % m for m in months] + ["기간 합계 금액", "기간 건수", "기간 회원 수"], 1)
        ed = XlsxSheet("적립_항목별_상세", widths=[10, 18, 34, 15, 12, 12])
        ed.add(["월", "구분", "항목", "금액", "건수", "회원 수"], 1)
        col_tot = [0.0] * len(months)
        for k in ek:
            d = earn_items[k]
            allu = set()
            for e in d.values():
                allu |= e[2]
            amts = [R(d[m][0]) if m in d else 0 for m in months]
            for i, a in enumerate(amts):
                col_tot[i] += a if k[0] != "충전포인트 충전·환원" else 0
            ew.add([k[0], k[1]] + amts + [sum(amts), sum(e[1] for e in d.values()), len(allu)])
        ew.add(["합계", "(적립 + 취소적립)"] + [R(v) for v in col_tot] + [R(sum(col_tot)), "", ""], 3)
        for m in months:
            for k in ek:
                e = earn_items[k].get(m)
                if e:
                    ed.add([m, k[0], k[1], R(e[0]), e[1], len(e[2])])
        # 5·7) 사용 항목별
        order_u = {"사용": 0, "소멸": 1}
        uk = sorted(use_items, key=lambda k: (order_u.get(k[0], 9), -sum(e[0] + e[1] for e in use_items[k].values()), k[1]))
        uw = XlsxSheet("사용_항목별_월", widths=[10, 34] + [14] * len(months) + [15, 15, 15, 12, 12])
        uw.add(["구분", "항목"] + ["%s 금액" % m for m in months] + ["기간 적립포인트 사용", "기간 충전포인트 사용", "기간 합계 금액", "기간 건수", "기간 회원 수"], 1)
        ud = XlsxSheet("사용_항목별_상세", widths=[10, 10, 34, 15, 15, 15, 12, 12])
        ud.add(["월", "구분", "항목", "적립포인트 사용", "충전포인트 사용", "합계 금액", "건수", "회원 수"], 1)
        col_u = [0.0] * len(months)
        su = [0.0, 0.0]
        for k in uk:
            d = use_items[k]
            allu = set()
            for e in d.values():
                allu |= e[3]
            amts = [R(d[m][0] + d[m][1]) if m in d else 0 for m in months]
            pa, pc = sum(e[0] for e in d.values()), sum(e[1] for e in d.values())
            if k[0] == "사용":
                for i, a in enumerate(amts):
                    col_u[i] += a
                su[0] += pa; su[1] += pc
            uw.add([k[0], k[1]] + amts + [R(pa), R(pc), R(pa + pc), sum(e[2] for e in d.values()), len(allu)])
        uw.add(["합계", "(사용, 소멸 제외)"] + [R(v) for v in col_u] + [R(su[0]), R(su[1]), R(su[0] + su[1]), "", ""], 3)
        for m in months:
            for k in uk:
                e = use_items[k].get(m)
                if e:
                    ud.add([m, k[0], k[1], R(e[0]), R(e[1]), R(e[0] + e[1]), e[2], len(e[3])])
        data = build_xlsx([info, um, ut, ew, uw, ed, ud])
        log("  · Excel 생성 완료: 회원 %s명 · %s행 · %.0f초" % (format(len(users), ","), format(len(per), ","), time.time() - t0))
        return data, "닥터빌_포인트_%s_%s.xlsx" % (months[0].replace("-", ""), months[-1].replace("-", ""))
    finally:
        EXPORT_LOCK.release()


# --------------------------------------------------------------------------------------
# 갱신 = 신규 파일 적재 → 집계 → 암호화 → 게시
# --------------------------------------------------------------------------------------
_lock = threading.Lock()


def refresh(cfg, password):
    key = derive_key(get_meta(cfg), password)       # 비밀번호 먼저 확인
    if not _lock.acquire(blocking=False):
        raise RuntimeError("이미 갱신이 진행 중입니다.")
    PROGRESS.update(running=True, stage="start", file="", rows=0, fileIndex=0, fileCount=0)
    try:
        FAILED.clear()
        db = migrate_if_needed(cfg, open_db(cfg["db_path"]))
        try:
            loaded = ingest(db, cfg["raw_dir"])
            data = aggregate(db, cfg)
        finally:
            db.close()
        data["lastLoaded"] = loaded
        PROGRESS.update(stage="publish")
        pub = publish(cfg, encrypt_json(key, data))
        log(pub["message"])
        return {"ok": True, "data": data, "loaded": loaded, "failed": list(FAILED), "publish": pub}
    finally:
        PROGRESS.update(running=False, stage="")
        _lock.release()


# --------------------------------------------------------------------------------------
# localhost 갱신 서버
# --------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    cfg = None
    server_version = "dv-point-agent/" + VERSION

    def log_message(self, *a):
        pass

    def _cors(self):
        o = self.headers.get("Origin")
        if o and o in self.cfg["allowed_origins"]:
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _origin_ok(self):
        o = self.headers.get("Origin")
        return o is None or o in self.cfg["allowed_origins"]

    def do_GET(self):
        if not self._origin_ok():
            return self._send(403, {"ok": False, "error": "origin"})
        if self.path.startswith("/ping"):
            try:
                db = open_db(self.cfg["db_path"])
                n = len(pending_files(db, self.cfg["raw_dir"]))
                db.close()
            except Exception:
                n = None
            try:
                db = open_db(self.cfg["db_path"])
                sch = schema_of(db)
                db.close()
            except Exception:
                sch = None
            return self._send(200, {"ok": True, "agent": "dv-point", "version": VERSION, "pending": n,
                                    "running": PROGRESS["running"], "schema": sch, "needsRebuild": sch is not None and sch < SCHEMA_VERSION,
                                    "exportMaxMonths": int(self.cfg.get("export_max_months") or 6)})
        if self.path.startswith("/progress"):
            return self._send(200, dict(PROGRESS, ok=True))
        self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if not self._origin_ok():
            return self._send(403, {"ok": False, "error": "origin"})
        try:
            ln = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(ln, 10000)).decode("utf-8") or "{}")
        except Exception:
            return self._send(400, {"ok": False, "error": "bad_request"})
        if self.path.startswith("/export"):
            try:
                data, fname = export_xlsx(self.cfg, body.get("password") or "", body.get("from"), body.get("to"))
            except PermissionError as e:
                return self._send(401, {"ok": False, "error": "unauthorized", "message": str(e)})
            except (ValueError, RuntimeError) as e:
                return self._send(400, {"ok": False, "error": "bad_request", "message": str(e)})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"ok": False, "error": "failed", "message": str(e)})
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.startswith("/refresh"):
            try:
                return self._send(200, refresh(self.cfg, body.get("password") or ""))
            except PermissionError as e:
                return self._send(401, {"ok": False, "error": "unauthorized", "message": str(e)})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"ok": False, "error": "failed", "message": str(e)})
        self._send(404, {"ok": False, "error": "not_found"})


def serve(cfg):
    Handler.cfg = cfg
    srv = ThreadingHTTPServer(("127.0.0.1", int(cfg["port"])), Handler)
    print("=" * 64)
    print(" 닥터빌 포인트 갱신 서버 v%s — http://127.0.0.1:%s" % (VERSION, cfg["port"]))
    print(" Raw 폴더 : %s" % cfg["raw_dir"])
    print(" 누적 DB  : %s" % cfg["db_path"])
    print(" 대시보드 [포인트] 탭에서 [갱신]을 누르면 신규 CSV만 적재·집계합니다.")
    print(" 이 창을 닫으면 갱신 서버가 종료됩니다. (Ctrl+C)")
    print("=" * 64, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def main():
    ap = argparse.ArgumentParser(description="닥터빌 포인트 대시보드 로컬 에이전트")
    ap.add_argument("cmd", nargs="?", default="serve", choices=["serve", "refresh", "inspect", "status", "aggregate-json", "export"])
    ap.add_argument("--from", dest="frm")
    ap.add_argument("--to")
    ap.add_argument("--raw-dir")
    ap.add_argument("--db")
    ap.add_argument("--out")
    a = ap.parse_args()
    cfg = load_config()
    if a.raw_dir:
        cfg["raw_dir"] = a.raw_dir
    if a.db:
        cfg["db_path"] = a.db
    cfg["raw_dir"], cfg["db_path"] = os.path.abspath(cfg["raw_dir"]), os.path.abspath(cfg["db_path"])
    if a.cmd == "serve":
        serve(cfg)
    elif a.cmd == "refresh":
        pw = os.environ.get("DASHBOARD_PASSWORD") or getpass.getpass("대시보드 비밀번호: ")
        res = refresh(cfg, pw)
        for f in res["failed"]:
            print("건너뛴 파일: %s — %s" % (f["name"], f["error"]))
        print(res["publish"]["message"])
    elif a.cmd == "inspect":
        for name, path, size, _ in list_csv(cfg["raw_dir"]):
            enc = detect_encoding(path)
            with open(path, encoding=enc, errors="replace", newline="") as f:
                header = next(csv.reader(f))
            col = map_columns(header)
            print("\n■ %s (%.0f MB, %s)" % (name, size / 1e6, enc))
            print("  컬럼: %s" % header)
            print("  인식: %s" % {k: header[v] for k, v in col.items()})
    elif a.cmd == "status":
        db = open_db(cfg["db_path"])
        for r in db.execute("SELECT name, rows, inserted, dmin, dmax, loaded_at FROM files ORDER BY dmin"):
            print("%-50s 읽음 %10s  저장 %10s  %s ~ %s  (%s)" % (r[0], format(r[1], ","), format(r[2], ","), r[3], r[4], r[5]))
        print("미적재 신규 파일: %d개" % len(pending_files(db, cfg["raw_dir"])))
    elif a.cmd == "export":   # 예) python point_agent.py export --from 2026-03 --to 2026-08
        pw = os.environ.get("DASHBOARD_PASSWORD") or getpass.getpass("대시보드 비밀번호: ")
        data, fname = export_xlsx(cfg, pw, a.frm, a.to or a.frm)
        out = a.out or os.path.join(HERE, fname)
        with open(out, "wb") as f:
            f.write(data)
        print("저장: %s" % out)
    elif a.cmd == "aggregate-json":   # 개발·검증용: 적재 + 평문 집계 JSON 저장 (게시 안 함)
        db = open_db(cfg["db_path"])
        ingest(db, cfg["raw_dir"])
        data = aggregate(db, cfg)
        with open(a.out or os.path.join(HERE, "aggregate_debug.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
