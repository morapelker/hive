import { mountSpriteSheetPreview, type PreviewLevel } from './sprite-sheet-preview'

const LEVELS: PreviewLevel[] = [
  {
    min: 0,
    range: '0 · Idle',
    name: 'Off duty',
    description: 'A soft little loaf. Folded ears, forehead wrinkles and a proper pug curl.'
  },
  {
    min: 1,
    range: '1 worktree',
    name: 'Little legs, big plans',
    description: 'The same soft plush pug, now bounding along on four tiny paws.'
  },
  {
    min: 2,
    range: '2 worktrees',
    name: 'Happy helper',
    description: 'A sage linen bandana, softly folded and tied behind the neck.'
  },
  {
    min: 3,
    range: '3 worktrees',
    name: 'His pugness',
    description: 'A little polished gold crown, rounded tips and a teal jewel.'
  },
  {
    min: 4,
    range: '4 worktrees',
    name: 'Cape, please',
    description: 'Coral satin, a gold hem and an embroidered paw. Dressed to help.'
  },
  {
    min: 5,
    range: '5–9 worktrees',
    name: 'Super pug',
    description: 'The stitched cape badge counts your worktrees, with a little golden sparkle.'
  },
  {
    min: 10,
    range: '10–14 worktrees',
    name: 'Fast & furriest',
    description: 'Sapphire satin and brass goggles perched above those big glossy eyes.'
  },
  {
    min: 15,
    range: '15–19 worktrees',
    name: 'Pugs can fly',
    description: 'Amethyst velvet and soft ivory wings. A very small, very determined aviator.'
  },
  {
    min: 20,
    range: '20+ worktrees',
    name: 'Small but mighty',
    description: 'Midnight velvet, embroidered stars and a warm golden comet trail.'
  }
]

mountSpriteSheetPreview('pug', LEVELS)
