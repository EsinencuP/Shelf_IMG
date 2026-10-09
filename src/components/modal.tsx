'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть окно"><X size={20} /></button></div>
    {children}
  </dialog>;
}
