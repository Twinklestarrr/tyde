export interface OrganizationUpdateInput {
  orgId: string;
  description?: string | null;
  logoUrl?: string | null;
  logoUploadToken?: string | null;
}
