import { mountSpriteSheetPreview, type PreviewLevel } from './sprite-sheet-preview'

// Milestone copy from docs/french-bulldog-preview.html (design study 05).
const LEVELS: PreviewLevel[] = [
  {
    min: 0,
    range: '0 · Idle',
    name: 'Off-duty Frenchie',
    description: 'All ears, no deadlines. A seated portrait for the quiet moments.'
  },
  {
    min: 1,
    range: '1 worktree',
    name: 'Little hustle',
    description: 'Four little paws, one big idea. The first worktree gets him moving.'
  },
  {
    min: 2,
    range: '2 worktrees',
    name: 'Dressed for the job',
    description: 'A terracotta bandana and a little extra purpose in every stride.'
  },
  {
    min: 3,
    range: '3 worktrees',
    name: 'Tiny royalty',
    description: 'A gold crown between those bat ears. Every good run deserves one.'
  },
  {
    min: 4,
    range: '4 worktrees',
    name: 'Cape expectations',
    description: 'A coral cape catches the breeze. Small dog, superhero ambitions.'
  },
  {
    min: 5,
    range: '5–9 worktrees',
    name: 'Certified superdog',
    description: 'A live worktree counter and little golden sparks. Officially a multitasker.'
  },
  {
    min: 10,
    range: '10–14 worktrees',
    name: 'Cleared for takeoff',
    description: 'A midnight-blue cape and brass goggles. The pace is picking up.'
  },
  {
    min: 15,
    range: '15–19 worktrees',
    name: 'Above and beyond',
    description: 'A plum cape and soft ivory wings. Ambition has a new altitude.'
  },
  {
    min: 20,
    range: '20+ worktrees',
    name: 'Out of this world',
    description: 'A cosmic cape and a tiny star-powered jetpack. Maximum Frenchie.'
  }
]

mountSpriteSheetPreview('french-bulldog', LEVELS)
