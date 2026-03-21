import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.devtool = 'source-map';
    }
    return config;
  },
};

export default nextConfig;
