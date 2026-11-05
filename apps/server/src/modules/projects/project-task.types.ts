export type TaskRole = 'NAVIGATOR' | 'PM' | 'EXPERT';

export type TaskRecipient = { userId: string; role: TaskRole };

export interface TaskScope extends TaskRecipient {
  perspective: string;
  currentNodeCode: string;
  mainEligible: boolean;
  boardVisible: boolean;
}

export interface TaskSource extends TaskRecipient {
  taskType: string;
  sources: string[];
}

export interface TaskSnapshot {
  scopes: TaskScope[];
  sources: TaskSource[];
}
