// src/components/requisicoes/ReqDraggableCard.jsx
//
// Wrapper draggable (@dnd-kit) para cards de requisição no Kanban.
// Extraído de AdminPlanilha.jsx (linha 357).
//
import React from 'react';
import { useDraggable } from '@dnd-kit/core';

const ReqDraggableCard = ({ id, disabled, children }) => {
  const { attributes, listeners, setNodeRef } = useDraggable({ id, disabled });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={disabled ? '' : 'kanban-card-admin-draggable'}>
      {children}
    </div>
  );
};

export default ReqDraggableCard;
