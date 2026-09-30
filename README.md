# 닥터빌 회원 대시보드

구글시트(회원분석)의 회원 데이터를 **주 단위로 집계**해 GitHub Pages로 게시하는 정적 대시보드입니다.
공개 페이지에는 **집계 수치만** 올라가며 개인 식별 정보는 저장소에 들어오지 않습니다.
집계 데이터는 **비밀번호로 암호화**되어 저장되고, 접속 시 비밀번호를 입력해야 대시보드가 열립니다.

## 구성

```
docs/                       ← GitHub Pages 게시 폴더
  index.html                로그인 + 대시보드 (외부 라이브러리 없음)
  data/meta.json            키 유도 정보·비밀번호 검증값 (데이터 없음)
  data/index.enc.json       주차 목록 + 주간 KPI 이력 (암호화)
  data/snapshots/YYYY-Www.enc.json   주차별 스냅샷 (암호화)
scripts/
  aggregate.js              집계 로직 (Node/브라우저 공용)
  build.mjs                 집계치 수신(Apps Script) → 암호화 저장
apps-script/
  Code.gs                   시트에 붙이는 집계 웹앱 (토큰 확인 후 집계치만 반환)
  aggregate.gs              scripts/aggregate.js와 동일한 집계 로직
  crypto.mjs                암호화 모듈 (AES-256-GCM, PBKDF2-SHA256 60만 회)
  rekey.mjs                 비밀번호 변경 시 전체 재암호화
.github/workflows/weekly-snapshot.yml   매주 월 09:00 KST 자동 실행
```

## 대시보드 구성

| 영역 | 내용 |
|---|---|
| KPI | 전체 회원, 주간 신규(전주 대비), 최근 4주 신규, 7일/30일 내 로그인, 통합회원 전환율, SMS·이메일 수신 동의율 |
| 주간 추이 (12/26/52주) | 주간 신규 + 4주 이동평균, 누적 회원 수, 가입경로별 주간 신규, 활성·동의율 스냅샷 추이 |
| 항목별 특성 | 직종, 주 진료과, 근무처 시도, 가입경로, 연령대, 성별, 회원 상태, 통합회원 전환, 최종 로그인 경과, SMS·이메일 수신 — 전체 비중 막대 + 최근 4주 신규 비중 마커 + 주간 신규/증감 |
| 진료과별 연령 구성 | 상위 12개 진료과 × 연령대 히트맵 |

- 주는 월~일(KST) 기준이며, 월요일 실행 시 **직전 완료 주**를 보고 주차로 집계합니다.
- 가입 추이는 `가입일시`로 과거까지 재계산되고, 활성·동의율처럼 과거 재계산이 불가능한 지표는 매주 스냅샷으로 누적됩니다.

## 개인정보 보호 원칙

- 집계에 사용하지 않는 필드: 회원 USN, 이메일, 면허번호, 병원명, 세부 진료과명, 시군구
- 3명 미만 항목은 `기타(소수)`로 병합, 주간 신규 1~2명은 `<3`으로 표시
- 빌드 시 결과에 이메일 형태 문자열이 있으면 중단
- `.gitignore`로 CSV/엑셀/서비스 계정 키 커밋 차단

## 접속 보안

- 로그인 화면에서 비밀번호를 입력하면 브라우저 안에서 데이터를 복호화해 표시합니다. 서버로 비밀번호가 전송되지 않습니다.
- 저장소·페이지에는 암호문만 있어 비밀번호 없이 JSON 파일을 직접 열어도 내용을 볼 수 없습니다.
- "로그인 유지"를 체크하면 해당 브라우저 탭을 닫을 때까지 재입력 없이 접속됩니다. 로그아웃 버튼으로 즉시 해제됩니다.
- 한계: 정적 페이지라 로그인 시도 횟수 제한이 없습니다. 비밀번호가 추측 가능하면 암호문을 대입 공격할 수 있으므로 **12자 이상의 무작위 비밀번호**를 권장합니다.
- 비밀번호 변경: `OLD_PASSWORD=기존 NEW_PASSWORD=신규 node scripts/rekey.mjs` 실행 후 커밋하고, Secret `DASHBOARD_PASSWORD`도 변경합니다.

## 최초 설정 (1회) — Google Cloud 불필요

회원분석 시트 안에 Apps Script를 붙여 **시트 안에서 집계**하고, GitHub Actions는 집계치만 받아 암호화합니다.
원본 회원 행은 시트 밖으로 나가지 않으며, 서비스 계정·Cloud 프로젝트가 필요 없습니다.

```
구글시트(비공개) ──[Apps Script: 시트 안에서 집계]──▶ 집계치(개인정보 없음)
      ▲ 토큰 확인                                         │
GitHub Actions(매주 월) ──POST(토큰)──────────────────────┘
      └─ 비밀번호로 암호화 → docs/data 커밋 → Pages 반영
```

1. **Apps Script 붙이기**: 회원분석 시트 → *확장 프로그램 → Apps Script*
   - 기본 `Code.gs` 내용을 지우고 `apps-script/Code.gs` 내용을 붙여넣기
   - 파일 추가(+) → 스크립트 → 이름 `aggregate` → `apps-script/aggregate.gs` 내용 붙여넣기 → 저장
2. **토큰 생성**: 함수 선택에서 `setupToken` 실행 → 권한 승인(본인 계정) → *실행 로그*의 토큰 복사
   - (선택) `testAggregate` 실행 → 로그에 "총 ○○명, 주간 신규 ○○명"이 나오면 정상
3. **웹 앱 배포**: *배포 → 새 배포 → 유형 선택: 웹 앱* / 실행 사용자: **나** / 액세스 권한: **모든 사용자** → 배포 → 웹 앱 URL(`…/exec`) 복사
   - "모든 사용자"여도 토큰이 없으면 아무것도 반환하지 않고, 토큰이 있어도 집계치만 반환합니다.
4. **GitHub Secrets 등록** (저장소 *Settings → Secrets and variables → Actions → New repository secret*)
   - `APPS_SCRIPT_URL`: 웹 앱 URL
   - `APPS_SCRIPT_TOKEN`: 2단계 토큰
   - `DASHBOARD_PASSWORD`: 대시보드 접속 비밀번호 (현재 암호화에 사용한 비밀번호와 같아야 함)
5. **첫 실행**: *Actions → 주간 회원 스냅샷 → Run workflow* → 성공 후 대시보드에 반영 확인

GitHub Pages 설정: *Settings → Pages* → Source `Deploy from a branch`, Branch `main` / `/docs` (설정 완료 상태)

### 유지보수 메모
- 집계 로직(`scripts/aggregate.js`)을 고치면 `apps-script/aggregate.gs`에도 같은 내용을 붙여넣고 **배포 → 배포 관리 → 새 버전**으로 갱신합니다.
- 토큰 교체: `setupToken` 재실행 → Secret `APPS_SCRIPT_TOKEN` 변경
- 시트 탭 이름이 `시트1`이 아니면 `Code.gs`의 `SHEET_NAME`을 수정합니다.
- (대안) 서비스 계정 방식: `APPS_SCRIPT_URL`을 비우고 `GOOGLE_SERVICE_ACCOUNT_JSON`, `SHEET_ID` Secret을 등록하면 기존 방식으로 동작합니다.

## 운영

- 자동 실행: 매주 월요일 09:00 KST. 같은 주에 다시 실행하면 해당 주 스냅샷을 덮어씁니다.
- 로컬 테스트: `DASHBOARD_PASSWORD=... node scripts/build.mjs --csv 내보낸파일.csv` (CSV는 커밋하지 마세요)
- 시트 필드명이 바뀌면 `scripts/aggregate.js`의 `DIMS` 매핑을 수정합니다.
- 시트 데이터 적재(어드민 → 구글시트)는 별도 프로세스이므로, 적재가 늦어지면 해당 주 신규 수가 적게 집계될 수 있습니다.
