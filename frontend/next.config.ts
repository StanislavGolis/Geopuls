import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone-сборка нужна для Docker-образа (см. frontend/Dockerfile)
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
