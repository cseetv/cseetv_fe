/* ROI 다각형 그리기 캔버스
   클릭: 꼭짓점 추가 / 더블클릭: 완성 / 드래그: 이동 / 우클릭: 삭제
*/

import { useRef, useState, useCallback, useEffect } from "react";
import type { RoiPolygon } from "../types";

const COLORS = ["#EF4444", "#F59E0B", "#3B82F6", "#8B5CF6", "#10B981", "#EC4899"];

interface Props {
  imageUrl: string | null;
  width: number;
  height: number;
  polygons: RoiPolygon[];
  onChange: (polygons: RoiPolygon[]) => void;
}

export function RoiCanvas({ imageUrl, width, height, polygons, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<[number, number][]>([]);
  const [dragIdx, setDragIdx] = useState<{ polyIdx: number; ptIdx: number } | null>(null);

  // 캔버스 그리기
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);

    // 완성된 다각형 그리기
    polygons.forEach((poly) => {
      if (poly.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(poly.points[0][0], poly.points[0][1]);
      poly.points.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.closePath();
      ctx.fillStyle = poly.color + "15";
      ctx.fill();
      ctx.strokeStyle = poly.color;
      ctx.lineWidth = 2;
      ctx.stroke();

      // 꼭짓점
      poly.points.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = poly.color;
        ctx.fill();
      });

      // 이름
      const cx = poly.points.reduce((s, p) => s + p[0], 0) / poly.points.length;
      const cy = poly.points.reduce((s, p) => s + p[1], 0) / poly.points.length;
      ctx.fillStyle = poly.color;
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(poly.name, cx, cy);
    });

    // 그리는 중인 다각형
    if (currentPoints.length > 0) {
      ctx.beginPath();
      ctx.moveTo(currentPoints[0][0], currentPoints[0][1]);
      currentPoints.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.strokeStyle = COLORS[polygons.length % COLORS.length];
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      currentPoints.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
      });
    }
  }, [polygons, currentPoints, width, height]);

  useEffect(() => { draw(); }, [draw]);

  const getPos = (e: React.MouseEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = width / rect.width;
    const sy = height / rect.height;
    return [Math.round((e.clientX - rect.left) * sx), Math.round((e.clientY - rect.top) * sy)];
  };

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (dragIdx) return;
    const [x, y] = getPos(e);
    setDrawing(true);
    setCurrentPoints((prev) => [...prev, [x, y]]);
  };

  const handleDblClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (currentPoints.length < 3) return;

    const name = prompt("ROI 이름을 입력하세요:", `영역 ${polygons.length + 1}`) || `영역 ${polygons.length + 1}`;
    const newPoly: RoiPolygon = {
      id: `roi_${Date.now()}`,
      name,
      points: currentPoints,
      color: COLORS[polygons.length % COLORS.length],
    };
    onChange([...polygons, newPoly]);
    setCurrentPoints([]);
    setDrawing(false);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // 우클릭: 가까운 다각형 삭제
    const [x, y] = getPos(e);
    const idx = polygons.findIndex((p) =>
      p.points.some(([px, py]) => Math.hypot(px - x, py - y) < 15)
    );
    if (idx >= 0) {
      onChange(polygons.filter((_, i) => i !== idx));
    } else if (currentPoints.length > 0) {
      // 그리는 중이면 마지막 점 제거
      setCurrentPoints((prev) => prev.slice(0, -1));
      if (currentPoints.length <= 1) setDrawing(false);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (drawing) return;
    const [x, y] = getPos(e);
    // 기존 다각형 꼭짓점 드래그
    for (let pi = 0; pi < polygons.length; pi++) {
      for (let pti = 0; pti < polygons[pi].points.length; pti++) {
        const [px, py] = polygons[pi].points[pti];
        if (Math.hypot(px - x, py - y) < 10) {
          setDragIdx({ polyIdx: pi, ptIdx: pti });
          return;
        }
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragIdx) return;
    const [x, y] = getPos(e);
    const updated = [...polygons];
    updated[dragIdx.polyIdx] = {
      ...updated[dragIdx.polyIdx],
      points: updated[dragIdx.polyIdx].points.map((p, i) =>
        i === dragIdx.ptIdx ? [x, y] as [number, number] : p
      ),
    };
    onChange(updated);
  };

  const handleMouseUp = () => {
    setDragIdx(null);
  };

  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: `${width}/${height}` }}>
      {imageUrl ? (
        <img src={imageUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: 0.5, borderRadius: 8 }} />
      ) : (
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 30% 40%, #1a1a2e, #000)", borderRadius: 8 }} />
      )}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onClick={handleClick}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: drawing ? "crosshair" : "default", borderRadius: 8 }}
      />
      <div style={{ position: "absolute", bottom: 6, left: 8, fontSize: 9, color: "#ffffff60", background: "#00000088", padding: "2px 6px", borderRadius: 4 }}>
        {drawing ? "클릭: 꼭짓점 추가 | 더블클릭: 완성 | 우클릭: 되돌리기" : "클릭: 새 ROI 그리기 | 우클릭: 삭제 | 드래그: 이동"}
      </div>
    </div>
  );
}
