# JewelGuard API — 백엔드 가이드

## 빠른 시작

```bash
# 1. 가상환경 생성 및 활성화
python -m venv venv
source venv/bin/activate        # Mac/Linux
# venv\Scripts\activate         # Windows

# 2. 의존성 설치
pip install -r requirements.txt

# 3. 서버 실행
python main.py
# 또는
uvicorn main:app --reload --port 8000
```

서버가 실행되면 http://localhost:8000/docs 에서 Swagger UI로 API를 테스트할 수 있습니다.

## API 엔드포인트

| 메서드 | 경로 | 기능 |
|--------|------|------|
| GET | `/api/health` | 서버 상태 확인 |
| POST | `/api/analyze` | 단일 프레임 분석 (히스토그램, 진단) |
| POST | `/api/detect` | 움직임 감지 (두 프레임 비교) |
| POST | `/api/enhance` | 저조도 보정 (파이프라인) |
| POST | `/api/experiment/averaging` | 실험 1: N값별 SNR |
| POST | `/api/experiment/filters` | 실험 3: 필터 비교 |
| POST | `/api/experiment/threshold` | 실험 4: 임계값 ROC |

## curl 테스트 예시

```bash
# 서버 상태 확인
curl http://localhost:8000/api/health

# 프레임 분석
curl -X POST http://localhost:8000/api/analyze \
  -F "file=@test_image.jpg"

# 움직임 감지
curl -X POST http://localhost:8000/api/detect \
  -F "current=@frame2.jpg" \
  -F "previous=@frame1.jpg" \
  -F "threshold=30"

# 저조도 보정
curl -X POST http://localhost:8000/api/enhance \
  -F "file=@dark_image.jpg" \
  -F "averaging_n=10" \
  -F "noise_sigma=30"

# 실험: Averaging SNR
curl -X POST http://localhost:8000/api/experiment/averaging \
  -F "file=@test_image.jpg" \
  -F "n_values=1,2,5,10,30,100" \
  -F "sigma=30"
```

## 파일 구조

```
jewelguard-api/
├── main.py           # FastAPI 엔드포인트 (라우터)
├── processing.py     # OpenCV 영상처리 함수 (엔진)
├── requirements.txt  # Python 의존성
└── README.md         # 이 파일
```

## processing.py 주요 함수

| 함수 | 수업 토픽 | 역할 |
|------|----------|------|
| `analyze_histogram()` | #9 히스토그램 | 히스토그램 계산 + 화질 진단 |
| `contrast_stretch()` | #8 Contrast Enhancement | y=ax+b (Robust, 상하위 1% 제외) |
| `histogram_equalize()` | #10 Histogram EQ | CDF 기반 균등화 |
| `average_frames()` | #11 Image Averaging | N프레임 평균 |
| `detect_motion()` | #13 Image Difference | 프레임 차이 + ROI 위험도 |
| `apply_gaussian_filter()` | #20 Gaussian Filter | 가우시안 잡음 제거 |
| `apply_ideal_lowpass()` | #20 Ideal Filter | Ideal LP (링잉 발생) |
| `experiment_averaging()` | 실험 1 | N값별 SNR 측정 |
| `experiment_filters()` | 실험 3 | 9개 필터 비교 |
