// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Meter } from './Meter'

describe('Meter', () => {
  it('renders a meter and samples the live level getter', () => {
    const getLevel = vi.fn(() => 0.5)
    const { container } = render(<Meter getLevel={getLevel} label="Test level" />)
    // The meter is decorative (aria-hidden); the live value is read via a ref,
    // so query the element structurally rather than through the a11y tree.
    expect(container.querySelector('.meter__fill')).not.toBeNull()
    // The animation loop pulls the level at least once after mount.
    expect(getLevel).toHaveBeenCalled()
  })

  it('renders a clip LED only when a clip getter is provided', () => {
    const { container, rerender } = render(<Meter getLevel={() => 0} />)
    expect(container.querySelector('.meter__clip')).toBeNull()
    rerender(<Meter getLevel={() => 0} getClip={() => true} />)
    expect(container.querySelector('.meter__clip')).not.toBeNull()
  })
})
