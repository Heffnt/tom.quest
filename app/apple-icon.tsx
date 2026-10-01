import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#0a0e17",
        }}
      >
        {/* The same mark app/icon.svg draws, inlined through an SVG data URL. */}
        <img
          alt=""
          src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%2240%20-20%20560%20560%22%20fill%3D%22none%22%3E%0A%20%20%3Crect%20x%3D%2240%22%20y%3D%22-20%22%20width%3D%22560%22%20height%3D%22560%22%20rx%3D%2296%22%20ry%3D%2296%22%20fill%3D%22%230a0e17%22%2F%3E%0A%20%20%3Cg%20stroke%3D%22%23e8a040%22%20fill%3D%22%23e8a040%22%3E%0A%20%20%20%20%3Ccircle%20cx%3D%22320%22%20cy%3D%22270%22%20r%3D%22170%22%20stroke-width%3D%2243%22%20fill%3D%22none%22%2F%3E%0A%20%20%20%20%3Cline%20x1%3D%22168.95%22%20y1%3D%22192%22%20x2%3D%22471.05%22%20y2%3D%22192%22%20stroke-width%3D%2243%22%2F%3E%0A%20%20%20%20%3Cline%20x1%3D%22320%22%20y1%3D%22192%22%20x2%3D%22320%22%20y2%3D%22440%22%20stroke-width%3D%2243%22%2F%3E%0A%20%20%20%20%3Cline%20x1%3D%22320%22%20y1%3D%22192%22%20x2%3D%22181.74%22%20y2%3D%22368.94%22%20stroke-width%3D%2243%22%2F%3E%0A%20%20%20%20%3Cpolygon%20points%3D%22336.94%2C178.76%20557.84%2C461.50%20503.29%2C461.50%20303.06%2C205.24%22%20stroke%3D%22none%22%2F%3E%0A%20%20%20%20%3Ccircle%20cx%3D%22132.89%22%20cy%3D%22431.50%22%20r%3D%2230%22%20stroke%3D%22none%22%2F%3E%0A%20%20%3C%2Fg%3E%0A%3C%2Fsvg%3E"
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    ),
    size,
  );
}
