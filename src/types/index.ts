/* cseetv 공유 타입 정의 */

export interface MotionResult {
  detected: boolean;
  boxes: MotionBox[];
  total_motion_pixels: number;
  risk_score: number;
  risk_level: "safe" | "warn" | "danger";
  threshold_used?: number;
}

export interface MotionBox {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  in_roi?: string | null;
}

export interface QualityStats {
  brightness_mean: number;
  brightness_std: number;
  entropy: number;
  histogram: number[];
  diagnosis: "under_exposed" | "over_exposed" | "low_contrast" | "good";
  brightness_before?: number;
  brightness_after?: number;
  correction_type?: string;
}

export interface PipelineInfo {
  steps_applied: string[];
  enhanced_previews?: EnhancedStep[];
}

export interface EnhancedStep {
  step: string;
  base64: string;
  mean: number;
  std: number;
}

export interface FrameResult {
  type: "frame_meta" | "frame_result";
  frame_number: number;
  timestamp?: number;
  motion: MotionResult;
  quality: QualityStats;
  pipeline: PipelineInfo;
  frame_base64?: string;
  frame_skipped?: boolean;
}

export interface AlertItem {
  timestamp: string;
  risk_score: number;
  risk_level: string;
  motion_pixels: number;
  boxes: MotionBox[];
  message: string;
  frame_base64?: string;
}

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface RoiPolygon {
  id: string;
  name: string;
  points: [number, number][];
  color: string;
}

export interface Settings {
  threshold_value: number;
  min_motion_area: number;
  denoise_h: number;
  use_gaussian: boolean;
  gaussian_kernel: number;
  use_median: boolean;
  median_kernel: number;
  use_averaging: boolean;
  averaging_n: number;
  use_adaptive_threshold: boolean;
  use_shadow_removal: boolean;
  use_temporal_smoothing: boolean;
  temporal_frames: number;
  use_dynamic_threshold: boolean;
  alert_threshold: number;
  checks_per_second: number;
  jpeg_quality: number;
  transfer_mode: string;
  skip_unchanged_frames: boolean;
}

export interface VideoInfo {
  video_id: string;
  filename: string;
  fps: number;
  width: number;
  height: number;
  duration: number;
  total_frames: number;
}

export interface TimelinePoint {
  risk: number;
  motion: number;
}

export interface MetricsData {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface RocPoint {
  threshold: number;
  tpr: number;
  fpr: number;
}
