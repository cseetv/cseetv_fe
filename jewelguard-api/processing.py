"""
JewelGuard — 영상처리 엔진
OpenCV 기반 저조도 보정, 움직임 감지, 필터링, 실험 모듈
"""

import cv2
import numpy as np
from typing import Optional
import time
import base64


# ============================================================
# 1. 기본 유틸리티
# ============================================================

def encode_image_base64(img: np.ndarray, quality: int = 85) -> str:
    """OpenCV 이미지를 base64 문자열로 변환"""
    _, buffer = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buffer).decode('utf-8')


def decode_image_bytes(data: bytes) -> np.ndarray:
    """바이트 데이터를 OpenCV 이미지로 변환"""
    nparr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("이미지를 디코딩할 수 없습니다")
    return img


def to_grayscale(img: np.ndarray) -> np.ndarray:
    """컬러 이미지를 그레이스케일로 변환"""
    if len(img.shape) == 3:
        return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return img


# ============================================================
# 2. 히스토그램 분석 (토픽 #9)
# ============================================================

def compute_histogram(gray: np.ndarray) -> list:
    """그레이스케일 영상의 히스토그램 계산"""
    hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
    return hist.flatten().tolist()


def analyze_histogram(gray: np.ndarray) -> dict:
    """
    히스토그램 기반 화질 자동 진단
    교수님: "히스토그램 보고 객관적으로 평가하는 것이 중요합니다"
    """
    hist = compute_histogram(gray)
    total = gray.size
    mean = float(np.mean(gray))
    std = float(np.std(gray))

    # 엔트로피 계산
    prob = np.array(hist) / total
    prob = prob[prob > 0]
    entropy = float(-np.sum(prob * np.log2(prob)))

    # 분포 분석
    hist_arr = np.array(hist)
    left_ratio = float(np.sum(hist_arr[:85]) / total)
    right_ratio = float(np.sum(hist_arr[170:]) / total)

    # 진단
    if left_ratio > 0.6:
        diagnosis = "under_exposed"
        detail = "히스토그램이 왼쪽에 치우침 (저조도/어두운 영상)"
    elif right_ratio > 0.6:
        diagnosis = "over_exposed"
        detail = "히스토그램이 오른쪽에 치우침 (과노출/밝은 영상)"
    elif std < 40:
        diagnosis = "low_contrast"
        detail = "히스토그램이 좁게 모여 있음 (저대비)"
    else:
        diagnosis = "good"
        detail = "히스토그램이 골고루 분포 (양호)"

    return {
        "histogram": hist,
        "mean": round(mean, 2),
        "std": round(std, 2),
        "entropy": round(entropy, 2),
        "diagnosis": diagnosis,
        "diagnosis_detail": detail,
    }


# ============================================================
# 3. Contrast Stretching (토픽 #8)
# ============================================================

def contrast_stretch(gray: np.ndarray, percentile: float = 1.0) -> tuple:
    """
    Robust Contrast Stretching (상하위 percentile% 제외)
    교수님: "마이너스 1이 나오면 255가 돼버려요. 반드시 클리핑해야 합니다."
    """
    sorted_vals = np.sort(gray.flatten())
    n = len(sorted_vals)
    lo = int(sorted_vals[int(n * percentile / 100)])
    hi = int(sorted_vals[int(n * (100 - percentile) / 100)])

    if hi <= lo:
        hi = lo + 1

    a = 255.0 / (hi - lo)
    b = -a * lo

    result = np.clip(a * gray.astype(np.float64) + b, 0, 255).astype(np.uint8)

    return result, {"a": round(a, 3), "b": round(b, 1), "lo": lo, "hi": hi}


# ============================================================
# 4. Histogram Equalization (토픽 #10)
# ============================================================

def histogram_equalize(gray: np.ndarray) -> np.ndarray:
    """
    CDF 기반 히스토그램 균등화
    교수님: "CDF가 변환 함수로 쓰면 히스토그램이 이퀄라이즈된다"
    """
    return cv2.equalizeHist(gray)


# ============================================================
# 5. Image Averaging (토픽 #11)
# ============================================================

def simulate_noisy_frames(gray: np.ndarray, n: int, sigma: float) -> list:
    """원본에 가우시안 잡음을 N번 독립적으로 추가하여 N개의 잡음 프레임 생성"""
    frames = []
    for _ in range(n):
        noise = np.random.normal(0, sigma, gray.shape)
        noisy = np.clip(gray.astype(np.float64) + noise, 0, 255).astype(np.uint8)
        frames.append(noisy)
    return frames


def average_frames(frames: list) -> np.ndarray:
    """
    N프레임 픽셀별 평균
    교수님: "평균을 취하는 행위 자체가 노이즈를 감축시키는 행위이다"
    """
    stacked = np.stack([f.astype(np.float64) for f in frames], axis=0)
    averaged = np.mean(stacked, axis=0)
    return np.clip(averaged, 0, 255).astype(np.uint8)


def calculate_snr(original: np.ndarray, processed: np.ndarray) -> float:
    """SNR(dB) 계산: 10·log₁₀(신호파워/잡음파워)"""
    signal = original.astype(np.float64)
    noise = processed.astype(np.float64) - signal
    signal_power = np.mean(signal ** 2)
    noise_power = np.mean(noise ** 2)
    if noise_power < 1e-10:
        return 99.0
    return round(10 * np.log10(signal_power / noise_power), 2)


def calculate_psnr(original: np.ndarray, processed: np.ndarray) -> float:
    """PSNR(dB) 계산: 10·log₁₀(255²/MSE)"""
    mse = np.mean((original.astype(np.float64) - processed.astype(np.float64)) ** 2)
    if mse < 1e-10:
        return 99.0
    return round(10 * np.log10(255.0 ** 2 / mse), 2)


# ============================================================
# 6. 필터링 (토픽 #16, #18, #20)
# ============================================================

def apply_moving_average(gray: np.ndarray, ksize: int = 5) -> np.ndarray:
    """
    Moving Average Filter (로패스)
    교수님: "모빙 에버리지는 곱하기를 안 써요. 고속으로는 최고입니다."
    """
    return cv2.blur(gray, (ksize, ksize))


def apply_gaussian_filter(gray: np.ndarray, ksize: int = 5, sigma: float = 1.5) -> np.ndarray:
    """
    Gaussian Filter (로패스, 링잉 없음)
    교수님: "가우시안 FFT = 가우시안. 필터의 기술 = 가우시안 함수의 기술"
    """
    return cv2.GaussianBlur(gray, (ksize, ksize), sigma)


def apply_ideal_lowpass(gray: np.ndarray, cutoff_ratio: float = 0.2) -> np.ndarray:
    """
    Ideal Low-pass Filter (주파수 영역, 링잉 발생)
    교수님: "블록을 FFT하면 sinc 함수가 나옵니다. 링잉이 발생."
    """
    rows, cols = gray.shape
    crow, ccol = rows // 2, cols // 2

    # FFT
    dft = np.fft.fft2(gray.astype(np.float64))
    dft_shift = np.fft.fftshift(dft)

    # Ideal mask
    mask = np.zeros((rows, cols), np.float64)
    cutoff = int(min(rows, cols) * cutoff_ratio)
    cv2.circle(mask, (ccol, crow), cutoff, 1, -1)

    # Apply & IFFT
    filtered = dft_shift * mask
    result = np.fft.ifft2(np.fft.ifftshift(filtered))
    result = np.clip(np.abs(result), 0, 255).astype(np.uint8)

    return result


def measure_edge_preservation(original: np.ndarray, filtered: np.ndarray) -> float:
    """에지 보존도 측정 (Sobel 기반)"""
    edge_orig = cv2.Sobel(original, cv2.CV_64F, 1, 1)
    edge_filt = cv2.Sobel(filtered, cv2.CV_64F, 1, 1)

    if np.std(edge_orig) < 1e-10:
        return 100.0

    correlation = np.corrcoef(edge_orig.flatten(), edge_filt.flatten())[0, 1]
    return round(max(0, correlation * 100), 1)


def detect_ringing(original: np.ndarray, filtered: np.ndarray) -> bool:
    """링잉 현상 감지 (에지 근처 진동 분석)"""
    edge = cv2.Canny(original, 50, 150)
    diff = np.abs(original.astype(np.float64) - filtered.astype(np.float64))

    # 에지 근처(5px)에서의 진동 크기
    kernel = np.ones((11, 11), np.uint8)
    edge_region = cv2.dilate(edge, kernel)
    edge_diff = diff[edge_region > 0]

    if len(edge_diff) == 0:
        return False

    return float(np.std(edge_diff)) > 15.0


# ============================================================
# 7. 움직임 감지 (토픽 #13)
# ============================================================

def detect_motion(
    current: np.ndarray,
    previous: np.ndarray,
    threshold: int = 30,
    roi_zones: Optional[list] = None,
) -> dict:
    """
    Image Difference 기반 움직임 감지
    교수님: "두 프레임을 빼면 움직인 부분만 보입니다. 보안 시스템은 다 이걸 쓰고 있습니다."
    """
    gray_curr = to_grayscale(current)
    gray_prev = to_grayscale(previous)

    # 프레임 차이
    diff = cv2.absdiff(gray_curr, gray_prev)

    # 임계값 이진화
    _, binary = cv2.threshold(diff, threshold, 255, cv2.THRESH_BINARY)

    # 모폴로지로 잡음 제거
    kernel = np.ones((5, 5), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    # 움직임 통계
    motion_pixels = int(np.sum(binary > 0))
    total_pixels = binary.size
    motion_ratio = round(motion_pixels / total_pixels, 4)

    # 바운딩 박스
    bbox = {"x": 0, "y": 0, "w": 0, "h": 0}
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        all_points = np.vstack(contours)
        x, y, w, h = cv2.boundingRect(all_points)
        bbox = {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}

    # ROI 기반 위험도 계산
    risk_score = 0.0
    roi_hits = []
    h_img, w_img = binary.shape

    if roi_zones:
        for zone in roi_zones:
            zx = int(zone["x"] / 100 * w_img)
            zy = int(zone["y"] / 100 * h_img)
            zw = int(zone["w"] / 100 * w_img)
            zh = int(zone["h"] / 100 * h_img)

            roi_mask = np.zeros_like(binary)
            roi_mask[zy:zy+zh, zx:zx+zw] = 255

            overlap = cv2.bitwise_and(binary, roi_mask)
            pixels_in_zone = int(np.sum(overlap > 0))

            roi_hits.append({
                "zone": zone["name"],
                "weight": zone.get("weight", 1.0),
                "pixels_in_zone": pixels_in_zone,
            })
            risk_score += pixels_in_zone * zone.get("weight", 1.0)

        # 정규화 (0~100)
        max_possible = total_pixels * max(z.get("weight", 1.0) for z in roi_zones) * 0.1
        risk_score = min(100, risk_score / max(max_possible, 1) * 100)
    else:
        risk_score = min(100, motion_ratio * 2000)

    risk_score = round(risk_score, 1)
    risk_level = "danger" if risk_score > 70 else "warn" if risk_score > 40 else "safe"

    # 차이 영상 시각화 (컬러)
    diff_vis = cv2.applyColorMap(diff, cv2.COLORMAP_JET)
    diff_vis[binary == 0] = [0, 0, 0]

    return {
        "motion_detected": motion_pixels > 500,
        "motion_pixels": motion_pixels,
        "motion_ratio": motion_ratio,
        "motion_bbox": bbox,
        "risk_score": risk_score,
        "risk_level": risk_level,
        "roi_hits": roi_hits,
        "diff_image_base64": encode_image_base64(diff_vis),
        "binary_image_base64": encode_image_base64(binary),
    }


# ============================================================
# 8. 저조도 보정 파이프라인 (토픽 #8, #10, #11)
# ============================================================

def enhance_low_light(
    gray: np.ndarray,
    averaging_n: int = 10,
    apply_stretch: bool = True,
    apply_histeq: bool = True,
    noise_sigma: float = 30.0,
) -> dict:
    """
    저조도 보정 파이프라인: Averaging → Contrast Stretch → Histogram EQ
    각 단계별 히스토그램 변화를 추적
    """
    steps = []

    # 원본 분석
    orig_analysis = analyze_histogram(gray)
    steps.append({
        "step": "original",
        "label": "원본 (저조도)",
        "mean": orig_analysis["mean"],
        "std": orig_analysis["std"],
        "entropy": orig_analysis["entropy"],
        "histogram": orig_analysis["histogram"],
    })

    current = gray.copy()

    # Step 1: Image Averaging (잡음 제거)
    if averaging_n > 1:
        frames = simulate_noisy_frames(gray, averaging_n, noise_sigma)
        current = average_frames(frames)
        snr_noisy = calculate_snr(gray, frames[0])
        snr_avg = calculate_snr(gray, current)

        analysis = analyze_histogram(current)
        steps.append({
            "step": f"averaging_n{averaging_n}",
            "label": f"Averaging (N={averaging_n})",
            "mean": analysis["mean"],
            "std": analysis["std"],
            "entropy": analysis["entropy"],
            "histogram": analysis["histogram"],
            "snr_before": snr_noisy,
            "snr_after": snr_avg,
            "snr_improvement": round(snr_avg - snr_noisy, 2),
        })

    # Step 2: Contrast Stretching
    if apply_stretch:
        current, stretch_info = contrast_stretch(current)
        analysis = analyze_histogram(current)
        steps.append({
            "step": "contrast_stretch",
            "label": "Contrast Stretching",
            "mean": analysis["mean"],
            "std": analysis["std"],
            "entropy": analysis["entropy"],
            "histogram": analysis["histogram"],
            "params": stretch_info,
        })

    # Step 3: Histogram Equalization
    if apply_histeq:
        current = histogram_equalize(current)
        analysis = analyze_histogram(current)
        steps.append({
            "step": "histogram_eq",
            "label": "Histogram EQ",
            "mean": analysis["mean"],
            "std": analysis["std"],
            "entropy": analysis["entropy"],
            "histogram": analysis["histogram"],
        })

    return {
        "enhanced_image_base64": encode_image_base64(current),
        "pipeline_steps": steps,
        "final_diagnosis": analyze_histogram(current)["diagnosis"],
    }


# ============================================================
# 9. 실험 모듈
# ============================================================

def experiment_averaging(gray: np.ndarray, n_values: list, sigma: float = 30.0) -> dict:
    """실험 1: N값별 Image Averaging SNR 비교"""
    results = {"n_values": n_values, "sigma": sigma, "snr_experiment": [], "snr_theory": [], "psnr": []}

    for n in n_values:
        frames = simulate_noisy_frames(gray, n, sigma)
        averaged = average_frames(frames)

        snr = calculate_snr(gray, averaged)
        psnr = calculate_psnr(gray, averaged)
        theory = round(calculate_snr(gray, frames[0]) + 10 * np.log10(n), 2)

        results["snr_experiment"].append(snr)
        results["snr_theory"].append(theory)
        results["psnr"].append(psnr)

    return results


def experiment_filters(gray: np.ndarray, sigma: float = 30.0) -> list:
    """실험 3: 필터 비교 (Moving Average vs Gaussian vs Ideal)"""
    # 잡음 추가
    noisy = simulate_noisy_frames(gray, 1, sigma)[0]
    results = []

    configs = [
        ("Moving Avg", "3x3", lambda img: apply_moving_average(img, 3)),
        ("Moving Avg", "5x5", lambda img: apply_moving_average(img, 5)),
        ("Moving Avg", "7x7", lambda img: apply_moving_average(img, 7)),
        ("Gaussian", "3x3 σ=1.0", lambda img: apply_gaussian_filter(img, 3, 1.0)),
        ("Gaussian", "5x5 σ=1.5", lambda img: apply_gaussian_filter(img, 5, 1.5)),
        ("Gaussian", "7x7 σ=2.0", lambda img: apply_gaussian_filter(img, 7, 2.0)),
        ("Ideal LP", "cutoff=0.1", lambda img: apply_ideal_lowpass(img, 0.1)),
        ("Ideal LP", "cutoff=0.2", lambda img: apply_ideal_lowpass(img, 0.2)),
        ("Ideal LP", "cutoff=0.3", lambda img: apply_ideal_lowpass(img, 0.3)),
    ]

    for name, size, fn in configs:
        start = time.time()
        filtered = fn(noisy)
        elapsed = round((time.time() - start) * 1000, 1)

        results.append({
            "name": name,
            "size": size,
            "psnr": calculate_psnr(gray, filtered),
            "edge_preservation": measure_edge_preservation(gray, filtered),
            "ringing": detect_ringing(gray, filtered),
            "processing_time_ms": elapsed,
        })

    return results


def experiment_threshold(
    current: np.ndarray,
    previous: np.ndarray,
    thresholds: list,
) -> dict:
    """실험 4: 임계값별 검출률/오탐률 (ROC 데이터)"""
    results = {"thresholds": thresholds, "motion_pixels": [], "motion_ratios": []}

    for t in thresholds:
        detection = detect_motion(current, previous, threshold=t)
        results["motion_pixels"].append(detection["motion_pixels"])
        results["motion_ratios"].append(detection["motion_ratio"])

    return results
