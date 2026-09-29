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
  build.mjs                 시트 조회 → 스냅샷 생성 → 암호화 저장
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

## 최초 설정 (1회)

1. **Google Cloud 서비스 계정 생성**
   - Google Cloud Console → 프로젝트 선택 → *API 및 서비스* → **Google Sheets API 사용 설정**
   - *IAM 및 관리자 → 서비스 계정* → 계정 생성 → *키 → JSON 키 추가* 후 다운로드
2. **구글시트 공유**: 회원분석 시트를 서비스 계정 이메일(`...@...iam.gserviceaccount.com`)에 **뷰어** 권한으로 공유
3. **GitHub Secrets 등록** (저장소 *Settings → Secrets and variables → Actions*)
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: 다운로드한 JSON 파일 내용 전체
   - `SHEET_ID`: `18Oaw2ldpiZu_uvaNQG2YNkwou7WWpi6itI-Scjpn070`
   - `DASHBOARD_PASSWORD`: 대시보드 접속 비밀번호 (현재 암호화에 사용한 비밀번호와 같아야 함)
   - (선택) Variables에 `SHEET_RANGE` — 시트 탭 이름이 `시트1`이 아닐 때
4. **GitHub Pages 설정**: *Settings → Pages → Build and deployment* → Source: `Deploy from a branch`, Branch: `main` / `/docs`
5. **첫 실행**: *Actions → 주간 회원 스냅샷 → Run workflow*

## 운영

- 자동 실행: 매주 월요일 09:00 KST. 같은 주에 다시 실행하면 해당 주 스냅샷을 덮어씁니다.
- 로컬 테스트: `DASHBOARD_PASSWORD=... node scripts/build.mjs --csv 내보낸파일.csv` (CSV는 커밋하지 마세요)
- 시트 필드명이 바뀌면 `scripts/aggregate.js`의 `DIMS` 매핑을 수정합니다.
- 시트 데이터 적재(어드민 → 구글시트)는 별도 프로세스이므로, 적재가 늦어지면 해당 주 신규 수가 적게 집계될 수 있습니다.
