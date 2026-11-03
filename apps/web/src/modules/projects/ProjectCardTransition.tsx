import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './project-card-motion.css';

/** 重启动效而不重挂载子页面，保留详情中的表单和焦点。 */
export function ProjectCardTransition({
  children,
  direction = 'forward',
  transitionKey = 0,
  className = '',
}: {
  children: ReactNode;
  direction?: 'forward' | 'back';
  transitionKey?: string | number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node) node.dataset.cardMotion = node.dataset.cardMotion === 'a' ? 'b' : 'a';
  }, [direction, transitionKey]);

  return (
    <div
      ref={ref}
      className={`project-card-transition ${className}`}
      data-card-direction={direction}
    >
      {children}
    </div>
  );
}
