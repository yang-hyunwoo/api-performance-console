# API Performance Console

**OpenAPI 기반 API 성능 테스트 및 부하 테스트 도구**

번들 `spring-performance-test`는 PostgreSQL을 사용하는 테스트 대상 서버입니다. `POST /api/test-data/seed`로 예제 데이터를 생성할 수 있습니다. 콘솔의 실행 이력은 Express가 관리하는 별도의 로컬 SQLite에 저장됩니다.

API Performance Console은 Spring Boot 등 백엔드 애플리케이션의 API를 대상으로 성능 테스트를 실행하고 결과를 확인할 수 있는 로컬 웹 애플리케이션입니다.

OpenAPI(Swagger) 명세를 불러와 테스트할 API를 선택하고, VU(가상 사용자 수), 테스트 시간, 요청 데이터 등을 설정하여 k6 기반 부하 테스트를 실행할 수 있습니다.

POST 테스트에서 생성된 데이터를 기존 DELETE API를 이용해 자동으로 정리하는 기능도 지원합니다.

## 개발 배경

백엔드 개발 과정에서 API의 정상 동작뿐만 아니라, 동시 요청이 증가했을 때 응답 시간과 처리량이 어떻게 변화하는지 확인하는 것도 중요하다고 생각했습니다.

기존 k6를 사용하려면 테스트 대상 API마다 JavaScript 스크립트를 작성하고, 요청 데이터와 가상 사용자 수 등을 직접 설정해야 하는 번거로움이 있었습니다.

특히 여러 API를 반복적으로 테스트하거나 POST 요청처럼 테스트 데이터 생성과 정리가 필요한 경우에는 스크립트 관리에 추가적인 작업이 필요했습니다.

이러한 불편함을 줄이기위해, **Swagger 문서만으로 API를 선택해 별도의 k6 스크립트 작성 없이 부하 테스트를 수행할 수 있는 환경**을 만들고자 프로젝트를 개발했습니다.

## 개발 목표

- **테스트 자동화**: Swagger 문서를 분석해 k6 테스트 스크립트 자동 생성
- **테스트 편의성**: 웹 UI에서 가상 사용자 수, 테스트 시간, 요청 데이터 설정
- **다양한 API 지원**: HTTP 메서드 및 인증이 필요한 API 테스트
- **데이터 관리**: 고유 테스트 데이터 생성 및 테스트 종료 후 자동 정리
- **성능 분석**: RPS, 평균 응답 시간, P95 응답 시간, 실패율 시각화

궁극적으로 API 성능 테스트의 반복 작업을 줄이고, 백엔드 개발자가 API 성능을 보다 쉽게 측정하고 비교할 수 있도록 하는 것이 목표입니다.

## 1. 주요 기능

| 기능 | 설명 |
|---|---|
| OpenAPI 연동 | Swagger/OpenAPI 명세를 불러와 API 목록 표시 |
| HTTP Method 지원 | GET, POST, PUT, PATCH, DELETE |
| 부하 테스트 | VU 및 실행 시간 설정 |
| 인증·공통 헤더 | Bearer 토큰, 사용자 정의 헤더, 요청별 X-Request-ID 자동 생성 |
| Query Parameter | 요청별 쿼리 파라미터 설정 |
| Request Body | JSON 요청 데이터 설정 |
| 고유 데이터 생성 | POST 요청의 특정 문자열 필드에 고유값 추가 |
| Path ID 분배 | PUT, PATCH, DELETE 요청의 ID 분배 |
| 자동 데이터 삭제 | 단일 POST 테스트에서 옵션을 켜면 종료 후 생성된 리소스 삭제 |
| 시나리오 | 여러 API를 순서대로 실행하고 응답 JSON에서 추출한 값을 다음 단계에서 재사용 |
| 성능 지표 | RPS, 평균 응답 시간, P95, 실패율. 단일 API는 실시간 모니터링 지원 |
| 실행 이력 및 비교 | SQLite 저장, 기준·비교 실행 검색, 평균 RPS·P95·HTTP 실패율 비교 |
| 결과 저장 | k6 실행 스크립트 및 JSON 리포트 저장 |

## 2. 기술 스택

| 구분 | 기술 |
|---|---|
| Frontend | React, Vite |
| Backend | Node.js, Express, TypeScript |
| 실행 이력 | SQLite (`node:sqlite`) |
| 예제 API | Spring Boot, Java 21, PostgreSQL |
| Load Testing | Grafana k6 |
| API Specification | OpenAPI / Swagger |
| HTTP Client | Fetch API, k6/http |

## 3. 사전 요구 사항

프로젝트 실행 전 다음 프로그램이 필요합니다.

- Node.js 24 권장. 백엔드는 내장 `node:sqlite`를 사용합니다.
- npm
- Grafana k6
- Git
- 테스트 대상 API 서버. 번들 Spring Boot 예제를 사용할 경우 JDK 21과 Docker Compose가 필요합니다.

### 3.1 Node.js 설치

Node.js 공식 홈페이지에서 LTS 버전을 설치합니다.

https://nodejs.org/

설치 후 터미널에서 버전을 확인합니다.

```bash
node -v
npm -v
```

### 3.2 Git 설치

https://git-scm.com/downloads

설치 확인:

```bash
git --version
```

## 4. k6 설치

백엔드는 Node.js의 `child_process.spawn()`을 사용해 k6를 실행합니다.

따라서 **백엔드가 실행되는 운영체제에서 `k6` 명령어를 사용할 수 있어야 합니다.**

### 4.1 Windows

PowerShell에서 다음 명령어를 실행합니다.

```powershell
winget install --id k6.k6 -e
```

설치가 완료되면 PowerShell을 새로 열고 확인합니다.

```powershell
k6 version
where.exe k6
```

정상 출력 예시:

```text
k6.exe v2.4.0
C:\Program Files\k6\k6.exe
```

설치가 완료되었는데 명령어를 찾을 수 없다면 Windows 환경 변수 `Path`에 k6 설치 폴더를 추가합니다.

1. `Win + R` 실행
2. `sysdm.cpl` 입력
3. 고급 → 환경 변수
4. 사용자 변수의 `Path` 선택
5. k6 설치 폴더 추가

예시:

```text
C:\Program Files\k6
```

실행 파일인 `k6.exe`가 아니라 **실행 파일이 들어 있는 폴더**를 등록해야 합니다.

환경 변수를 변경했다면 터미널과 IDE를 재시작합니다.

### 4.2 macOS

Homebrew를 사용합니다.

```bash
brew install k6
k6 version
```

### 4.3 Linux (Ubuntu / Debian)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates gnupg curl

curl -fsSL https://dl.k6.io/key.gpg | \
  sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg

echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list

sudo apt-get update
sudo apt-get install -y k6
```

설치 확인:

```bash
k6 version
```

## 프로젝트 다운로드

GitHub 저장소에서 프로젝트를 다운로드합니다.

### 방법 1. Git Clone

```bash
git clone https://github.com/USERNAME/REPOSITORY.git
```

```bash
cd REPOSITORY
```

`USERNAME`과 `REPOSITORY`는 실제 GitHub 저장소 정보로 변경해야 합니다.

### 방법 2. ZIP 다운로드

1. GitHub 저장소에 접속합니다.
2. `Code` 버튼을 클릭합니다.
3. `Download ZIP`을 선택합니다.
4. 다운로드한 ZIP 파일을 압축 해제합니다.
5. VS Code 등 개발 도구에서 프로젝트 폴더를 엽니다.

## 5. 프로젝트 구조

| 경로 | 역할 |
| --- | --- |
| `frontend/src/pages/SingleApiTestPage.tsx` | 단일 API 설정, 실시간 모니터링 및 결과 |
| `frontend/src/pages/ScenarioTestPage.tsx` | 시나리오 단계, 응답 변수, 실행 및 동작 판정 |
| `frontend/src/pages/TestHistoryPage.tsx` | 실행 이력과 성능 비교 |
| `frontend/src/components/api/RequestHeadersEditor.tsx` | 두 화면의 공통 인증·헤더 설정 |
| `backend/src/server.ts` | Express API |
| `backend/src/openapi.ts` | OpenAPI 명세 파싱 |
| `backend/src/generator.ts`, `backend/src/scenario.ts` | 단일 API와 시나리오용 k6 스크립트 생성 |
| `backend/src/runner.ts` | k6 실행·중지, 결과 집계, 단일 POST 자동 정리 |
| `backend/src/history.ts` | SQLite 이력 저장 및 검색 |
| `backend/generated/`, `backend/reports/` | 생성 스크립트와 k6 결과 파일 |
| `spring-performance-test/` | PostgreSQL 기반 예제 API |

## 콘솔 백엔드 API

| 메서드 | 경로 | 역할 |
| --- | --- | --- |
| GET | `/api/health` | 백엔드 상태 확인 |
| GET | `/api/openapi?url=...` | OpenAPI JSON 조회 및 파싱 |
| GET | `/api/tests/active` | 현재 실행 상태 조회 |
| GET | `/api/tests/events` | 실시간 지표 SSE 구독 |
| POST | `/api/tests/active/cancel` | 실행 중단 요청 |
| POST | `/api/tests` | 단일 API 테스트 실행 및 결과 반환 |
| POST | `/api/scenarios/run` | 시나리오 실행 및 단계별 결과 반환 |
| POST | `/api/scenarios/run/:requestId/cancel` | 해당 시나리오 실행 중지 |
| GET | `/api/tests/history` | 저장된 실행 이력 조회. `q`로 검색하고 `before`로 이전 기록을 조회 |


## 6. 프로젝트 설치

프론트엔드와 백엔드의 의존성을 각각 설치합니다.

**Frontend**

```bash
cd frontend
npm install
```

**Backend**

```bash
cd ../backend
npm install
```

`package.json`에 필요한 의존성이 이미 정의되어 있다는 전제입니다.

### 환경 변수 설정

`backend/.env` 파일을 생성합니다. k6가 시스템 PATH에 등록돼 있으면 빈 파일로 둬도 됩니다. 콘솔 백엔드는 `127.0.0.1:4000`에서 실행됩니다.

**K6_PATH는 필수 환경 변수가 아닙니다.**

운영체제 PATH에 k6가 등록되어 있다면 별도로 설정하지 않아도 됩니다.

백엔드에서는 다음 방식으로 실행 파일을 결정합니다.

```typescript
const K6_PATH = process.env.K6_PATH || "k6";
```

PATH를 사용하지 않고 실행 파일을 직접 지정하려면 다음과 같이 설정할 수 있습니다.

Windows 예시:

```dotenv
K6_PATH="C:/Program Files/k6/k6.exe"
```

이 설정은 해당 컴퓨터의 실제 설치 경로와 일치해야 합니다.


## 7. 프로젝트 실행

프론트엔드, 백엔드, 테스트 대상 API 서버를 각각 실행합니다.

### 7.1 백엔드 실행

터미널 1:

```bash
cd backend
npm run dev
```

정상 실행 시:

```text
K6 Runner: http://127.0.0.1:4000
```

서버 상태 확인:

```http
GET http://127.0.0.1:4000/api/health
```

정상 응답:

```json
{
  "status": "OK"
}
```

### 7.2 프론트엔드 실행

터미널 2:

```bash
cd frontend
npm run dev -- --port 5173 --strictPort
```

브라우저에서 접속합니다.

http://localhost:5173

### 7.3 테스트 대상 서버 실행

번들 Spring Boot 예제를 사용할 경우 프로젝트 루트에서 PostgreSQL을 먼저 실행합니다.

```powershell
cd spring-performance-test
docker compose up -d
.\gradlew.bat bootRun
```

macOS·Linux에서는 같은 디렉터리에서 `./gradlew bootRun`으로 실행합니다. 번들 PostgreSQL 접속 포트는 `5300`입니다.

예시 API 서버 주소:

```text
http://localhost:8080
```

Swagger/OpenAPI 주소 예시:

```text
http://localhost:8080/v3/api-docs
```

Springdoc OpenAPI를 사용하는 Spring Boot 프로젝트의 일반적인 경로이며, 프로젝트 설정에 따라 다를 수 있습니다.

## 8. OpenAPI 연결

API Performance Console에 접속한 뒤 OpenAPI 명세 URL을 입력합니다.

Swagger UI 주소가 아니라 **OpenAPI JSON 문서 주소**를 사용합니다.

API 목록을 불러온 뒤 테스트할 API를 선택합니다.

예시:

```text
http://localhost:8080/v3/api-docs
```

OpenAPI 명세를 불러오면 등록된 API 목록에서 테스트할 엔드포인트를 선택할 수 있습니다.

현재 백엔드는 보안상 `localhost`와 `127.0.0.1` 주소만 허용합니다.

## 9. API 성능 테스트

### 9.1 GET 테스트

조회 API의 응답 속도와 처리량을 측정합니다.

예시:

```http
GET /api/animals
```

설정 예시:

| 항목 | 값 |
|---|---|
| Method | GET |
| VU | 10 |
| Duration | 30s |
| Access Token | 필요 시 입력 |

테스트를 실행하면 k6가 지정된 시간 동안 요청을 반복합니다.

### 9.2 POST 테스트

리소스 생성 API의 성능을 측정합니다.

예시:

```http
POST /api/animals
Content-Type: application/json
```

Request Body:

```json
{
  "name": "Test Animal",
  "code": "TEST"
}
```

고유값 생성 대상 필드로 `code`를 선택하면 요청마다 실행 ID, VU, 반복 횟수를 조합한 접미사가 추가됩니다.

예시:

```text
TEST_abc123_1_0
TEST_abc123_1_1
TEST_abc123_2_0
```

이를 통해 동일한 문자열 값으로 인한 중복 제약 조건 오류를 줄일 수 있습니다.

고유값 생성 기능은 현재 요청 본문의 최상위 문자열 필드를 대상으로 합니다.

### 9.3 PUT / PATCH 테스트

기존 리소스를 수정하는 API를 테스트합니다.

예시:

```http
PATCH /api/animals/{id}
```

ID 목록:

```text
101
102
103
```

**Same 모드**

일반적인 요청 실행 모드입니다. 선택한 Path와 설정에 따라 요청이 반복됩니다.

**Distributed 모드**

입력한 ID를 요청마다 분배합니다.

예시:

```text
PATCH /api/animals/101
PATCH /api/animals/102
PATCH /api/animals/103
PATCH /api/animals/101
...
```

여러 리소스를 대상으로 수정 요청을 분산할 때 사용합니다.

### 9.4 DELETE 테스트

삭제 API는 ID 분배 모드로 실행합니다.

예시:

```http
DELETE /api/animals/{id}
```

입력한 ID:

```text
101
102
103
```

k6의 `shared-iterations` 실행 방식을 사용하여 각 ID에 대해 한 번씩 DELETE 요청을 실행하도록 구성합니다.

DELETE는 실제 데이터를 삭제하므로 반드시 테스트용 데이터를 대상으로 실행하세요.

## 시나리오 테스트

1. **시나리오 테스트** 화면에서 OpenAPI를 불러오고, `POST /api/records`와 `PUT /api/records/{id}`를 순서대로 추가합니다. 각 단계의 요청 본문을 설정합니다.
2. POST 단계의 **응답 변수 추출**에서 변수명 `recordId`와 응답 JSON 경로 `id`를 입력합니다. 예제 API의 응답은 `{"id":101, ...}` 형태입니다. 프로젝트마다 응답 구조가 다를 수 있으므로 실제 응답을 확인하세요.
3. 경로를 선택하려면 **응답 JSON 샘플**에 `{"id":101}`처럼 실제 응답을 붙여넣고, **+ 응답 변수 추가 → 샘플에서 경로 선택**에서 `id`를 고릅니다. 화면에 추출값이 표시되며 샘플은 브라우저에서만 분석합니다.
4. PUT의 **이전 단계 변수 선택**에서 `recordId`를 고릅니다. 설정에는 `${recordId}`가 들어가고, 실행할 때는 같은 반복의 POST가 반환한 실제 ID가 쓰입니다.
5. **부하 설정**에서 VU와 실행 시간을 선택합니다. 기본 실행 시간은 10초입니다. **반복 사이 대기 시간**은 모든 단계를 실행한 뒤 다음 반복 전까지 기다리는 시간이며, 기본값은 0초입니다.
6. **시나리오 실행**을 누릅니다. 결과에서 단계별 성공, HTTP 실패, 응답 변수 추출 실패, 건너뜀과 **시나리오 동작 판정**을 확인할 수 있습니다.

POST 응답에서 ID를 얻지 못하면 그 변수가 필요한 PUT은 건너뜁니다. 실행 중 **실행 중지**를 눌러도 대상 서버가 이미 처리한 생성·수정은 남습니다. 시나리오의 생성 데이터는 자동으로 정리되지 않습니다.

## 인증·공통 헤더

- **Bearer 토큰** 입력값은 `Authorization: Bearer …`로 전달됩니다.
- **헤더 추가**에서 `X-API-Key`, `X-CSRF-TOKEN` 등 프로젝트가 요구하는 헤더를 입력할 수 있습니다. 같은 대상 서버의 단일 API와 시나리오에서 공유하며, 단계별 헤더를 지정한 경우 해당 단계의 값이 우선합니다.
- **요청마다 X-Request-ID 자동 생성**을 켜면 k6가 요청마다 UUID를 생성합니다.
- 헤더 값은 시나리오 JSON 미리보기에서 가려지고 생성된 k6 스크립트와 실행 이력 DB에 저장되지 않습니다. CSRF 토큰을 쿠키나 응답 헤더에서 자동으로 가져오는 방식은 현재 지원하지 않습니다.

## 테스트 이력 저장 및 비교

단일 API와 시나리오의 실행 기록은 Express가 `backend/.local/test-history.sqlite`에 저장합니다. 저장 파일은 첫 조회 또는 저장 시 자동 생성되며, 테스트 대상 Spring 서버의 PostgreSQL과 별개입니다. 기존 k6 리포트는 자동으로 가져오지 않습니다.

1. 사이드바에서 **테스트 이력**을 엽니다. 실행 기록의 **테스트 유형** 열에서 단일 API와 시나리오를 구분할 수 있습니다.
2. **비교할 실행 검색**에서 요청 경로, 테스트 유형 또는 날짜를 검색하고 비교할 실행을 선택합니다. 예를 들어 `GET /api/records`, `시나리오`, `2026-11-22`로 검색할 수 있습니다.
3. **기준 실행 검색**에서 비교할 실행보다 오래된 완료 기록을 찾습니다. 두 검색창은 불러온 화면 목록과 별개로 저장된 전체 이력을 검색하며, 결과는 최신 30건을 표시합니다.
4. 기준과 비교 결과에서 **평균 RPS, P95 응답 시간, HTTP 실패율**을 확인합니다. 실패율 차이는 퍼센트포인트(%p)로 표시합니다.

같은 대상·요청 순서·부하 설정의 기록을 우선 기준으로 선택합니다. 조건이 다른 기록도 비교할 수 있으며, 이 경우 변화량은 참고용입니다. 코드 변경 전후 성능을 비교하려면 요청 데이터와 서버 환경도 맞춰서 실행하세요. 인증 헤더와 요청 본문은 이력에 저장하지 않습니다.

## 10. POST 테스트 데이터 자동 삭제

POST 부하 테스트는 DB에 많은 데이터를 생성할 수 있습니다.

API Performance Console은 테스트 종료 후 생성된 리소스를 자동으로 삭제하는 기능을 제공합니다.

별도의 Spring Boot 전용 Cleanup Controller 없이 기존 DELETE API를 재사용합니다.

### 10.1 자동 삭제 설정

POST API를 선택한 뒤 자동 삭제 옵션을 활성화합니다.

설정 예시:

| 항목 | 값 |
|---|---|
| POST Path | `/api/animals` |
| 자동 삭제 | 활성화 |
| DELETE API Path | `/api/animals/{id}` |
| POST 응답 ID 경로 | `data.id` |

DELETE API는 OpenAPI 목록에서 선택하거나 직접 경로를 입력할 수 있습니다.

현재 구현에서 자동 삭제 경로는 `{id}` 플레이스홀더를 사용해야 합니다.

### 10.2 POST 응답 형식

예를 들어 POST 응답이 다음과 같다고 가정합니다.

```json
{
  "data": {
    "id": 101,
    "name": "Test Animal"
  }
}
```

응답 ID 경로를 다음과 같이 설정합니다.

```text
data.id
```

POST 응답이 아래와 같다면:

```json
{
  "id": 101
}
```

다음과 같이 설정합니다.

```text
id
```

### 10.3 자동 삭제 처리 과정

```text
1. POST 부하 테스트 시작
           ↓
2. POST 응답에서 생성 ID 추출
           ↓
3. Node.js Runner에서 ID 수집
           ↓
4. k6 부하 테스트 종료
           ↓
5. 수집된 ID 중복 제거
           ↓
6. DELETE API 자동 호출
           ↓
7. 삭제 성공/실패 결과 표시
```

예를 들어 생성 ID가 `101`, `102`, `103`이라면 다음 요청을 실행합니다.

```http
DELETE /api/animals/101
DELETE /api/animals/102
DELETE /api/animals/103
```

### 10.4 자동 삭제 결과

응답 예시:

```json
{
  "cleanupResult": {
    "attempted": true,
    "success": true,
    "total": 3,
    "deleted": 3,
    "failed": 0,
    "missingIdCount": 0,
    "extractionErrorCount": 0,
    "failedIds": [],
    "message": "3건의 DELETE 요청이 성공했습니다."
  }
}
```

| 필드 | 설명 |
|---|---|
| `attempted` | 자동 삭제 시도 여부 |
| `success` | 자동 삭제 성공 여부 |
| `total` | 수집된 고유 ID 개수 |
| `deleted` | DELETE 요청 성공 건수 |
| `failed` | DELETE 요청 실패 건수 |
| `missingIdCount` | 응답에서 ID를 찾지 못한 건수 |
| `extractionErrorCount` | ID 추출 중 오류가 발생한 건수 |
| `failedIds` | 삭제 실패 ID 및 오류 정보 |

**주의 사항**

- POST 응답에 생성 ID가 포함되어야 합니다.
- 해당 ID로 삭제할 수 있는 DELETE API가 있어야 합니다.
- DELETE API에 필요한 인증 및 권한이 충족되어야 합니다.
- ID 추출 실패 시 일부 데이터가 남을 수 있습니다.
- HTTP DELETE 성공 응답이 실제 DB 삭제를 보장하지는 않습니다.
- 대량 POST 요청에서 ID별 로그 출력은 성능 측정에 영향을 줄 수 있습니다.

따라서 자동 삭제 기능은 우선 소규모 테스트로 검증한 뒤 사용하는 것을 권장합니다.

## 11. 성능 테스트 결과

테스트 종료 후 주요 성능 지표를 확인할 수 있습니다.

| 지표 | 설명 |
|---|---|
| Total Requests | 총 HTTP 요청 수 |
| RPS | 초당 평균 요청 수 |
| Average Response Time | 평균 응답 시간 |
| P95 Response Time | 요청 중 95%가 완료되는 응답 시간 기준 |
| Failure Rate | k6가 집계한 HTTP 요청 실패율 |

예시:

```text
Total Requests:       12,500
RPS:                  416.67
Average Response:     85.30 ms
P95 Response:         210.50 ms
Failure Rate:         0.20%
```

위 수치는 설명을 위한 예시입니다.

단일 API 화면에서 **성능 목표 판정**을 켜면 사용자가 설정한 P95 상한, HTTP 실패율 상한, 최소 RPS를 기준으로 판정합니다. 시나리오 화면은 단계별 성공·실패와 응답 변수 추출 여부를 기준으로 동작을 판정합니다.

## 12. 테스트 결과 파일

k6 실행 시 스크립트와 결과 JSON 파일을 저장합니다.

```text
backend/
├── generated/
│   └── 2026-11-20_09-30-00_POST_api_animals_a1b2c3d4.js
│
└── reports/
    └── 2026-11-20_09-30-00_POST_api_animals_a1b2c3d4.json
```

파일명에는 다음 정보가 포함됩니다.

```text
실행일시_HTTP메서드_API경로_고유ID
```

`generated/`에는 실제 실행한 k6 스크립트가 저장됩니다.

`reports/`에는 성능 테스트 결과가 JSON으로 저장됩니다.

## 13. API 서버 엔드포인트

전체 목록은 [콘솔 백엔드 API](#콘솔-백엔드-api)를 참고하세요.

### 테스트 실행 요청 예시

```http
POST http://127.0.0.1:4000/api/tests
Content-Type: application/json
```

```json
{
  "baseUrl": "http://localhost:8080",
  "method": "POST",
  "path": "/api/animals",
  "vus": 5,
  "duration": "10s",
  "query": {},
  "requestBody": {
    "name": "Test Animal"
  },
  "uniqueFields": ["name"],
  "pathIds": [],
  "pathIdParameter": "id",
  "pathIdMode": "same",
  "autoCleanup": true,
  "cleanupPath": "/api/animals/{id}",
  "cleanupIdField": "data.id",
  "commonHeaders": {},
  "generateRequestId": false
}
```

## 14. 문제 해결

### `k6` 명령어를 찾을 수 없는 경우

```text
spawn k6 ENOENT
```
Node.js가 k6 실행 파일을 찾지 못하는 경우입니다.

먼저 터미널에서 확인합니다.

```powershell
k6 version
where.exe k6
```

Windows PATH 확인:

```powershell
$env:Path -split ";" |
  Where-Object { $_ -like "*k6*" }
```

Node.js PATH 확인:

```powershell
node -e "console.log(process.env.PATH)"
```

PATH에 k6 설치 폴더가 없다면 환경 변수에 추가해야 합니다.

### PowerShell에서는 되지만 WebStorm에서는 안 되는 경우

Windows에 k6를 설치한 후에도 WebStorm에서 실행하는 Node.js가 기존 PATH를 사용하면 오류가 발생할 수 있습니다.

해결 방법:

1. WebStorm과 백엔드 종료
2. JetBrains Toolbox를 포함한 관련 프로세스 종료
3. WebStorm 재실행
4. WebStorm 터미널에서 `k6 version` 확인
5. 백엔드 재실행

WebStorm 터미널에서 임시로 PATH를 추가할 수도 있습니다.

```powershell
$env:Path += ";C:\Program Files\k6"
k6 version
npm run dev
```

위 설정은 현재 터미널 세션에만 적용됩니다.

WebStorm의 Run/Debug Configuration으로 실행하는 경우 해당 실행 구성의 환경 변수도 별도로 확인해야 합니다.

### `K6_PATH`가 undefined인 경우

```text
[K6 PATH] undefined
```

이는 오류가 아닙니다.

`.env`에서 `K6_PATH`를 설정하지 않았을 때 나타나는 정상적인 값입니다.

`runner.ts`에서 `process.env.K6_PATH || "k6"`를 사용하면 시스템 PATH의 k6를 실행합니다.



### OpenAPI를 불러오지 못하는 경우

다음 항목을 확인합니다.

- Spring Boot 서버가 실행 중인지 확인
- `/v3/api-docs` 주소가 정상적으로 JSON을 반환하는지 확인
- `localhost` 또는 `127.0.0.1`을 사용하는지 확인
- Spring Security에서 OpenAPI 엔드포인트 접근을 허용하는지 확인

### POST 자동 삭제가 실행되지 않는 경우

다음 사항을 확인합니다.

- 자동 삭제 옵션이 활성화되어 있는지
- POST 응답에 ID가 존재하는지
- `cleanupIdField`가 실제 응답 구조와 일치하는지
- DELETE API Path가 `{id}`를 포함하는지
- DELETE 요청에 필요한 권한이 있는지
- k6 stderr 로그에 `K6_CREATED_ID`가 기록되는지

### DELETE API가 401 또는 403을 반환하는 경우

Access Token 및 삭제 권한을 확인합니다.

### 테스트 결과가 실패로 표시되는 경우

k6의 임계값을 초과했거나 요청에 실패했을 수 있습니다.

HTTP 실패 로그, 응답 상태 코드, 응답 시간 및 실패율을 확인하세요.

## 15. Docker 환경

현재 로컬 개발 환경에서는 Windows에 Node.js와 k6를 각각 설치해 사용합니다.

향후 Docker 배포 시에는 Node.js 백엔드 이미지에 k6를 함께 설치하는 방식을 사용할 수 있습니다.

```text
Docker Container
├── Node.js Backend
│   └── runner.ts
└── k6
    └── Load Test Execution
```

이 경우에도 동일한 실행 코드를 사용할 수 있습니다.

```typescript
const K6_PATH = process.env.K6_PATH || "k6";
```

다만 Docker 이미지에 k6 실행 파일이 실제로 설치되어 있어야 하며, 테스트 대상 API의 네트워크 주소와 생성 파일의 저장 경로도 컨테이너 환경에 맞게 구성해야 합니다.

별도의 k6 컨테이너를 사용하는 구성이라면 프로세스 실행 방식과 파일 공유 구조를 추가로 설계해야 합니다.


## 16. 사용 시 주의 사항

이 도구는 현재 **로컬 개발 및 테스트 환경**을 대상으로 설계되었습니다.

- 운영 DB를 연결한 상태에서 POST·PUT·PATCH·DELETE 부하 테스트를 실행하지 마세요.
- 성능 테스트용 DB와 데이터를 별도로 준비하세요.
- 자동 삭제 기능을 활성화하더라도 데이터가 남을 가능성이 있습니다.
- 테스트 실행 전 삭제 대상 API와 권한을 확인하세요.
- VU를 높이기 전에 낮은 부하로 정상 동작을 검증하세요.
- 현재 POST 생성 ID 수집은 로그 기반이므로 초고부하 환경에서는 별도의 수집 방식이 필요합니다.

## 17. 향후 개선 예정

- 대량 테스트에 적합한 생성 ID 수집 방식
- 응답 헤더와 쿠키에서 변수 추출
- 시나리오 실시간 모니터링
- 성능 비교 기준 실행 고정
---
## 참고 문서

- [Grafana k6 공식 문서](https://grafana.com/docs/k6/latest/)
- [k6 설치 가이드](https://grafana.com/docs/k6/latest/set-up/install-k6/)
- [k6 GitHub Releases](https://github.com/grafana/k6/releases)
- [Node.js 공식 문서](https://nodejs.org/docs/latest-v24.x/api/)
- [Vite 공식 문서](https://vite.dev/)
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)