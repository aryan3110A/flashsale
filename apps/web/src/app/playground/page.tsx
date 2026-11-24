'use client';
import { PageHeader } from '@/components/ui';
import { RateLimiterDemo } from '@/components/playground/RateLimiterDemo';
import { CacheDemo } from '@/components/playground/CacheDemo';
import { WorkerDemo } from '@/components/playground/WorkerDemo';
import { BreakerDemo } from '@/components/playground/BreakerDemo';
import { LoadTestDemo } from '@/components/playground/LoadTestDemo';

export default function PlaygroundPage() {
  return (
    <div>
      <PageHeader eyebrow="Live demo" title="System design playground" subtitle="Trigger the distributed-systems behaviours yourself. Every button talks to the real gateway, Redis, PostgreSQL, queue and worker running in Docker." />
      <div className="space-y-6">
        <RateLimiterDemo />
        <CacheDemo />
        <WorkerDemo />
        <BreakerDemo />
        <LoadTestDemo />
      </div>
    </div>
  );
}
