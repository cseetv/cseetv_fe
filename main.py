"""
JewelGuard API Server
FastAPI + OpenCV 기반 CCTV 영상 분석 백엔드
"""

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import json
import time
from typing import Optional

from processing import (
    decode_image_bytes,
    to_grayscale,
    analyze_histogram,
    enhance_low_light,
    detect_motion,
    experiment_averaging,
    experiment_filters,
    experiment_threshold,
    encode_image_base64,
)

app = FastAPI(
    title="JewelGuard API",
    description="CCTV 이상 움직임 감지 및 알림 시스템 — 영상처리 백엔드",
    version="1.0.0",
)

# CORS 설정 (프론트엔드 도메인 허용)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",      # Vite 개발 서버
        "http://localhost:3000",      # CRA 개발 서버
        "https://jewelguard.vercel.app",  # 배포 도메인
        "*",                          # 개발 중 편의 (배포 시 제거)
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# Health Check
# ============================================================

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "JewelGuard API", "version": "1.0.0"}


# ============================================================
# POST /api/analyze — 단일 프레임 분석
# ============================================================

@app.post("/api/analyze")
async def analyze_frame(file: UploadFile = File(...)):
    """
    이미지를 업로드하면 히스토그램 분석 + 화질 진단 결과를 반환합니다.
    
    - histogram: 256개 빈도값
    - mean, std, entropy: 통계량
    - diagnosis: under_exposed / over_exposed / low_contrast / good
    """
    try:
        start = time.time()
        data = await file.read()
        img = decode_image_bytes(data)
        gray = to_grayscale(img)

        result = analyze_histogram(gray)
        result["processing_time_ms"] = round((time.time() - start) * 1000, 1)
        result["image_size"] = {"width": img.shape[1], "height": img.shape[0]}

        return result

    except ValueError as e:
        raise HTTPException(status_code=400, detail={"code": "INVALID_IMAGE", "message": str(e)})
    except Exception as e:
        raise HTTPException(status_code=500, detail={"code": "PROCESSING_ERROR", "message": str(e)})


# ============================================================
# POST /api/detect — 움직임 감지
# ============================================================

@app.post("/api/detect")
async def detect_motion_endpoint(
    current: UploadFile = File(...),
    previous: UploadFile = File(...),
    threshold: int = Form(default=30),
    roi_zones: Optional[str] = Form(default=None),
):
    """
    두 프레임(현재/이전)을 비교하여 움직임을 감지합니다.
    
    - motion_detected: 움직임 여부
    - risk_score: 0~100 위험도 점수
    - roi_hits: ROI별 감지 결과
    - diff_image_base64: 차이 영상 시각화
    """
    try:
        start = time.time()

        curr_data = await current.read()
        prev_data = await previous.read()

        curr_img = decode_image_bytes(curr_data)
        prev_img = decode_image_bytes(prev_data)

        zones = None
        if roi_zones:
            zones = json.loads(roi_zones)

        result = detect_motion(curr_img, prev_img, threshold=threshold, roi_zones=zones)
        result["threshold_used"] = threshold
        result["processing_time_ms"] = round((time.time() - start) * 1000, 1)

        return result

    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail={"code": "INVALID_ROI", "message": "ROI JSON 형식이 올바르지 않습니다"})
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"code": "INVALID_IMAGE", "message": str(e)})
    except Exception as e:
        raise HTTPException(status_code=500, detail={"code": "PROCESSING_ERROR", "message": str(e)})


# ============================================================
# POST /api/enhance — 저조도 보정
# ============================================================

@app.post("/api/enhance")
async def enhance_image(
    file: UploadFile = File(...),
    averaging_n: int = Form(default=10),
    noise_sigma: float = Form(default=30.0),
    apply_stretch: bool = Form(default=True),
    apply_histeq: bool = Form(default=True),
):
    """
    저조도 영상을 보정합니다.
    파이프라인: Image Averaging → Contrast Stretching → Histogram EQ
    각 단계별 히스토그램 변화를 추적하여 반환합니다.
    """
    try:
        start = time.time()
        data = await file.read()
        img = decode_image_bytes(data)
        gray = to_grayscale(img)

        result = enhance_low_light(
            gray,
            averaging_n=averaging_n,
            apply_stretch=apply_stretch,
            apply_histeq=apply_histeq,
            noise_sigma=noise_sigma,
        )
        result["processing_time_ms"] = round((time.time() - start) * 1000, 1)

        return result

    except ValueError as e:
        raise HTTPException(status_code=400, detail={"code": "INVALID_IMAGE", "message": str(e)})
    except Exception as e:
        raise HTTPException(status_code=500, detail={"code": "PROCESSING_ERROR", "message": str(e)})


# ============================================================
# POST /api/experiment/averaging — 실험 1: Averaging SNR
# ============================================================

@app.post("/api/experiment/averaging")
async def run_averaging_experiment(
    file: UploadFile = File(...),
    n_values: str = Form(default="1,2,5,10,30,100"),
    sigma: float = Form(default=30.0),
):
    """
    실험 1: N값별 Image Averaging SNR 비교
    이론값 10·log₁₀(N)과 실험값을 비교합니다.
    """
    try:
        start = time.time()
        data = await file.read()
        img = decode_image_bytes(data)
        gray = to_grayscale(img)

        n_list = [int(n.strip()) for n in n_values.split(",")]
        result = experiment_averaging(gray, n_list, sigma)
        result["processing_time_ms"] = round((time.time() - start) * 1000, 1)

        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail={"code": "EXPERIMENT_ERROR", "message": str(e)})


# ============================================================
# POST /api/experiment/filters — 실험 3: 필터 비교
# ============================================================

@app.post("/api/experiment/filters")
async def run_filter_experiment(
    file: UploadFile = File(...),
    sigma: float = Form(default=30.0),
):
    """
    실험 3: Moving Average vs Gaussian vs Ideal 필터 비교
    PSNR, 에지 보존도, 링잉 여부, 처리 시간을 측정합니다.
    """
    try:
        start = time.time()
        data = await file.read()
        img = decode_image_bytes(data)
        gray = to_grayscale(img)

        results = experiment_filters(gray, sigma)

        return {
            "filters": results,
            "noise_sigma": sigma,
            "processing_time_ms": round((time.time() - start) * 1000, 1),
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail={"code": "EXPERIMENT_ERROR", "message": str(e)})


# ============================================================
# POST /api/experiment/threshold — 실험 4: 임계값 ROC
# ============================================================

@app.post("/api/experiment/threshold")
async def run_threshold_experiment(
    current: UploadFile = File(...),
    previous: UploadFile = File(...),
    thresholds: str = Form(default="10,20,30,40,50,60,80,100"),
):
    """
    실험 4: 임계값별 움직임 감지 결과 비교 (ROC 데이터)
    """
    try:
        start = time.time()

        curr_data = await current.read()
        prev_data = await previous.read()
        curr_img = decode_image_bytes(curr_data)
        prev_img = decode_image_bytes(prev_data)

        t_list = [int(t.strip()) for t in thresholds.split(",")]
        gray_curr = to_grayscale(curr_img)
        gray_prev = to_grayscale(prev_img)

        result = experiment_threshold(gray_curr, gray_prev, t_list)
        result["processing_time_ms"] = round((time.time() - start) * 1000, 1)

        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail={"code": "EXPERIMENT_ERROR", "message": str(e)})


# ============================================================
# 서버 실행
# ============================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
