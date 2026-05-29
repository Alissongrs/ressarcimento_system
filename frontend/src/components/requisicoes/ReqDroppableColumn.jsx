// src/components/requisicoes/ReqDroppableColumn.jsx
//
// Wrapper droppable (@dnd-kit) para colunas do Kanban de requisições.
// Extraído de AdminPlanilha.jsx (linha 366).
//
import React from 'react';
import { useDroppable } from '@dnd-kit/core';

const ReqDroppableColumn = ({ id, children }) => {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef}>{children}</div>;
};

export default ReqDroppableColumn;
