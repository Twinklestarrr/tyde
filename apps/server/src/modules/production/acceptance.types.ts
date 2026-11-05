export interface AcceptanceKey {
  projectId: number;
  subtaskId: number;
}

export interface AcceptanceSubmit extends AcceptanceKey {
  actualQuantity: string | number;
  actualDeliveryDate: string;
  quantityAdjustmentRemark?: string | null;
}

export interface AcceptanceReview extends AcceptanceKey {
  decision: 'ACCEPT' | 'REJECT';
  rejectReason?: string | null;
}
