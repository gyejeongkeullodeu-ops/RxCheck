# 미션 2 문서 정합성 검증

청구서와 영수증을 업로드해 Upstage Studio Agent로 문서를 분석하는 프로토타입입니다.

## 실행

1. `.env.example`을 복사해 `.env`를 만들고 `UPSTAGE_API_KEY`, `UPSTAGE_PROJECT_ID`, `UPSTAGE_AGENT_ID`를 설정합니다.
2. 의존성을 설치합니다.

```powershell
npm install
```

3. 서버를 실행합니다.

```powershell
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다. API 키는 코드나 저장소에 넣지 말고 로컬 `.env`에서만 관리합니다. 프로젝트 헤더를 포함해 파일과 Agent를 같은 프로젝트 범위에서 실행하며, 문서 API 요구사항에 맞춰 파일별로 각각 작업을 생성합니다.
