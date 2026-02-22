export interface Space {
  id: string
  name: string
  icon_type: string
  icon_value: string
  sort_order: number
  created_at: string
}

export interface ProjectSpaceAssignment {
  project_id: string
  space_id: string
}
