# cseetv_fe — 프론트엔드

야간 CCTV 영상의 이상 움직임 감지 및 알림 시스템 (프론트엔드)

## 팀원
- 이채원 (202210133) 
- 이예랑 (202310126) 

## 기술 스택
- React 18 + TypeScript
- Vite (빌드 도구)
- WebSocket (실시간 통신)
- Notification API + Service Worker (알림)
- PWA (Progressive Web App)

## 실행 방법

```bash
npm install
npm run dev
```

http://localhost:5173 에서 접속

## 배포

- **URL**: https://cseetv-fe.vercel.app/
- **플랫폼**: Vercel (자동 배포)

## 주요 기능

| 기능 | 설명 |
|------|------|
| 영상 업로드 분석 | 영상 파일 업로드 → 프레임별 파이프라인 분석 → 결과 재생 |
| 실시간 웹캠 | 카메라 연결 → 실시간 움직임 감지 + 바운딩 박스 오버레이 |
| 알림 | 위험도 초과 시 브라우저 알림 + 토스트 + 진동 (모바일) |
| 설정 | 감지 방식 선택 (Frame Diff / Running Avg / MOG2), 기법별 ON/OFF |
| CSV 내보내기 | 프레임별 분석 결과를 CSV로 다운로드 |
| 알림 히스토리 | 웹캠/영상별 카테고리 분류, 감지 프레임 캡처 |
| 녹화 | 웹캠 영상 녹화 및 저장 |

## 프로젝트 구조

```
src/
 ├── App.tsx                    # 메인 앱 (라우팅, 상태 관리)
 ├── components/
 │   ├── ui.tsx                 # UI 컴포넌트 (카드, 게이지, 타임라인 등)
 │   ├── CameraView.tsx         # 웹캠 뷰 (감지 박스, 시각, 녹화)
 │   ├── FramePlayer.tsx        # 분석 완료 후 영상 재생기
 │   └── RoiCanvas.tsx          # ROI 다각형 편집기
 ├── hooks/
 │   ├── useWebSocket.ts        # WebSocket 연결 관리
 │   ├── useApi.ts              # REST API 호출
 │   └── useNotification.ts     # 브라우저 알림 + PWA 푸시
 ├── types/
 │   └── index.ts               # TypeScript 타입 정의
 └── main.tsx                   # 엔트리 포인트
public/
 ├── manifest.json              # PWA 매니페스트
 └── sw.js                      # Service Worker
```

## 백엔드 연결

- 백엔드 레포: [cseetv_ip](../cseetv_ip/)
- WebSocket 주소: 환경변수 `VITE_WS_URL` (기본: `ws://localhost:8000/ws`)
- REST API: 환경변수 `VITE_API_URL` (기본: `http://localhost:8000`)

## 주요 실험 결과

| 기법 | Pixel F1 |
|------|----------|
| Baseline (Frame Diff) | 0.470 |
| Running Average (최종) | 0.566 |
| MOG2 (AI 비교) | 0.614 |

전통 기법만으로 AI의 92.1% 성능 달성
