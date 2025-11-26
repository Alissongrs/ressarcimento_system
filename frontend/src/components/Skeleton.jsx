import React from 'react';

export function Skeleton({ className = '', style }) {
  return <div className={`skeleton ${className}`} style={style} />;
}

export function SkeletonLine({ width = '100%', height = 12, className = '' }) {
  return <Skeleton className={className} style={{ width, height, borderRadius: 6 }} />;
}

export function SkeletonBlock({ w = '100%', h = 80, className = '' }) {
  return <Skeleton className={className} style={{ width: w, height: h, borderRadius: 10 }} />;
}

