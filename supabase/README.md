# 대시보드 DB(Supabase) 설정 안내

대시보드는 로그인·권한·데이터 저장에 Supabase를 사용합니다.

- **로그인**: Supabase 인증(이메일·비밀번호). 권한·이름·소속은 `profiles` 표
- **데이터**: 로그인 후 처음 불러온 데이터와 [갱신]으로 다시 불러온 데이터를 `datasets` 표에 저장 → 이후에는 DB 저장본을 표시
- **컨퍼런스 행사**: `conferences` 표에 바로 저장 (기존 회원 시트 `_conferences` 탭의 행사는 표가 비어 있을 때 한 번 자동으로 옮김)
- **연동 비밀값**: 구글시트·포인트 서버 비밀번호, 저장소 암호화 파일 키를 `app_secrets` 표에 저장 (내부 담당자만 읽음, 협력사는 세미나 요약 키만)

모든 표는 행 수준 보안(RLS)으로 막혀 있어, 로그인하지 않으면 아무것도 읽을 수 없습니다. 협력사 계정은 세미나 요약(회사별 제외)만 읽을 수 있습니다.

---

## 1. 프로젝트 만들기 (5분)

1. https://supabase.com 에 가입·로그인 → **New project**
2. 이름: `doctorville-dash` · Database Password: 강한 비밀번호(따로 보관) · **Region: Northeast Asia (Seoul)**
3. 생성 완료까지 1~2분 기다림

## 2. 스키마 만들기

1. 왼쪽 **SQL Editor → New query**
2. `schema.sql` 전체를 붙여 넣고 **Run** → `Success. No rows returned` 확인

## 3. 회원가입 막기 · 최고 관리자 만들기

1. **Authentication → Sign In / Providers**(또는 Settings) → **Allow new users to sign up** 끄기 → Save
   (계정은 대시보드 [계정 관리]에서 최고 관리자만 만듭니다)
2. **Authentication → Users → Add user → Create new user**
   - Email: `ojungin@mcircle.biz` · Password: 새 비밀번호 · **Auto Confirm User 체크** → Create
3. SQL Editor에서 `schema.sql` 맨 아래 **5) 최초 최고 관리자 등록** 문장의 주석(`-- `)을 지우고 그 3줄만 실행

## 4. 계정 관리 함수(Edge Function) 배포

1. 왼쪽 **Edge Functions → Deploy a new function → Via Editor**
2. 함수 이름: `admin-users`
3. `functions/admin-users/index.ts` 내용을 붙여 넣고 **Deploy**
4. 비밀 키(SERVICE_ROLE_KEY)는 Supabase가 자동으로 넣어 주므로 따로 설정하지 않습니다.

## 5. 대시보드에 연결 정보 넣기

1. **Project Settings → API**(또는 Data API / API Keys)에서 두 값을 복사
   - **Project URL**: `https://xxxx.supabase.co`
   - **anon public** 키 (또는 Publishable key)
2. 저장소 `docs/data/config.json` 에 추가

```json
{
  "appsScriptUrl": "(기존 값 그대로)",
  "supabaseUrl": "https://xxxx.supabase.co",
  "supabaseAnonKey": "eyJ...(anon public 키)"
}
```

> anon 키는 공개되어도 되는 키입니다(RLS로 보호). **service_role 키는 절대 config.json이나 채팅에 넣지 마세요.**

## 6. 처음 로그인 후 할 일 (최고 관리자)

1. 대시보드에 `ojungin@mcircle.biz` 로 로그인
2. **계정 관리 → 보안 키 설정** → 시스템 비밀번호(구글시트 연동 비밀번호) 입력 → 저장
   - 저장소 파일로 비밀번호가 맞는지 확인한 뒤 DB에 저장합니다
3. **계정 관리 → 계정 등록**으로 기존 계정(관리자·닥터빌 담당자·협력사 담당자)을 다시 등록하고 초기 비밀번호를 전달
   - 기존 accounts.json 계정은 더 이상 로그인에 쓰이지 않습니다
4. 메뉴를 한 번씩 열어 데이터가 DB에 저장되는지 확인 (상단 배지: `DB 저장 · 시각` → 다음부터 `DB 저장본 · 시각`)
5. 협력사 계정이 세미나를 보려면 내부 담당자가 매출 > 세미나 메뉴를 한 번 열어 요약본을 DB에 만들어 두어야 합니다

---

## 데이터 흐름

| 화면 | 원본 | 처음 열 때 | [갱신] |
|---|---|---|---|
| 회원 정보(닥터빌·팜빌) | 구글시트 Apps Script `get`/`refresh` | DB 저장본, 없으면 시트 → DB 저장 | 시트 재집계 → DB 덮어씀 |
| 활동성(닥터빌) | Apps Script `activity` | 〃 | 〃 |
| 매출 | Apps Script `sales` | 〃 | 〃 |
| 현황 > 세미나 | Apps Script `schedule` (월별) | 〃 (월별 저장) | 〃 |
| 포인트(닥터빌·팜빌) | 저장소 파일 / PC 포인트 갱신 서버 | DB 저장본, 없으면 파일 → DB | 갱신 서버 집계 결과를 DB에 저장 (저장소 업로드 없이 모두에게 반영) |
| 세미나 편성 · 팜빌 활동성 | 저장소 암호화 파일 | DB 저장본, 없으면 파일 → DB | 파일 다시 읽어 DB 덮어씀 |
| 컨퍼런스 | `conferences` 표 | 표에서 읽음 | 표에서 다시 읽음 |

- 저장 키 예: `api|get|dv`, `api|sales`, `api|schedule|{"month":"2026-10"}`, `file|data/points.enc.json`
- 회원 [갱신] 시 주차·월별 저장본(`api|get|dv|…`)은 비워서 다음에 다시 읽습니다.
- 저장소 `index.enc.json`(회원 저장본 목록)만 12시간이 지나면 파일을 다시 확인합니다.

## 문제 해결

- **로그인 화면에 'DB 연결 정보가 설정되지 않았습니다'** → 5단계 config.json 확인
- **'계정 권한이 등록되지 않았거나…'** → 3단계 3번(profiles 등록) 실행 여부 확인
- **계정 등록 시 '함수에 연결하지 못했습니다'** → 4단계 Edge Function 이름이 `admin-users` 인지, 배포 상태 확인
- **상단 배지 'DB 오류'** → 배지에 마우스를 올리면 원인 표시. 대부분 권한(RLS) 또는 네트워크 문제
- 저장본 강제 삭제: SQL Editor에서 `delete from datasets where key like 'api|sales%';`
