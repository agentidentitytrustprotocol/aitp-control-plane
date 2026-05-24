import type { ReactNode } from 'react';

export const metadata = {
  title: 'AITP Control Plane',
  description: 'Monitoring, registry, and audit for AITP agent deployments',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
