import Mathlib

/-- An even square has an even root. -/
theorem even_of_even_sq (p : ℕ) (h : Even (p ^ 2)) : Even p := by
  sorry

-- helper
lemma two_dvd_of_even {n : ℕ} (h : Even n) : 2 ∣ n := even_iff_two_dvd.mp h

/-- √2 is irrational. -/
theorem sqrt_two_irr : Irrational (Real.sqrt 2) := by
  have hsq : ∀ p q : ℕ, q ≠ 0 → (p : ℝ) / q = Real.sqrt 2 → p ^ 2 = 2 * q ^ 2 := by
    intro p q hq h
    sorry
  have hev : ∀ p : ℕ, Even (p ^ 2) → Even p := fun p h => even_of_even_sq p h
  exact irrational_sqrt_two
