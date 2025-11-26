// src/components/FlipCard.jsx
import React, { useState } from 'react';

export default function FlipCard({ front, back, className = '' }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div
      className={`relative [perspective:1000px] ${className}`}
      onClick={() => setFlipped(v => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e)=> (e.key==='Enter' || e.key===' ') && setFlipped(v=>!v)}
    >
      <div className={[
        'relative h-full w-full transition-transform duration-500 [transform-style:preserve-3d]',
        flipped ? '[transform:rotateY(180deg)]' : ''
      ].join(' ')}>
        {/* frente */}
        <div className="absolute inset-0 [backface-visibility:hidden]">
          {front}
        </div>
        {/* verso */}
        <div className="absolute inset-0 [transform:rotateY(180deg)] [backface-visibility:hidden]">
          {back}
        </div>
      </div>
    </div>
  );
}
