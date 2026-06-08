import User from '../models/User.js';
import { validationResult } from 'express-validator';
import fs from 'fs/promises';
import path from 'path';

function isGuestUser(user) {
  return /^guest_[^@]+@wellorahealth\.app$/i.test(String(user?.email || ''));
}

async function removeStoredProfileImage(relativePath) {
  if (!relativePath || !relativePath.startsWith('uploads/profileimages/')) return;
  try {
    await fs.unlink(path.join(process.cwd(), relativePath));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[removeStoredProfileImage]', error.message);
    }
  }
}

/**
 * Get current user profile
 */
export const getProfile = async (req, res) => {
  try {
    console.log('[getProfile] Request received for userId:', req.userId);
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get profile',
      error: error.message
    });
  }
};

/**
 * Update personal info
 */
export const updatePersonalInfo = async (req, res) => {
  try {
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[updatePersonalInfo] ❌ Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { firstName, lastName, email, dateOfBirth, biologicalSex } = req.body;
    const updateData = {};

    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (email !== undefined) updateData.email = email;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth;
    if (biologicalSex !== undefined) updateData.biologicalSex = biologicalSex;


    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }


    res.json({
      success: true,
      message: 'Personal info updated successfully',
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update personal info',
      error: error.message
    });
  }
};

export const updateProfileImage = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (isGuestUser(user)) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
      return res.status(403).json({
        success: false,
        message: 'Profile images are only available for signed-up users.',
      });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Profile image is required' });
    }

    await removeStoredProfileImage(user.profileImagePath);

    const relativePath = path
      .join('uploads', 'profileimages', req.file.filename)
      .replace(/\\/g, '/');
    user.profileImagePath = relativePath;
    user.profileImageUrl = `/${relativePath}`;
    await user.save();

    res.json({
      success: true,
      message: 'Profile image updated successfully',
      user,
    });
  } catch (error) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    res.status(500).json({
      success: false,
      message: 'Failed to update profile image',
      error: error.message,
    });
  }
};

/**
 * Update body info
 */
export const updateBodyInfo = async (req, res) => {
  try {
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[updateBodyInfo] ❌ Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { heightFeet, heightInches, heightCm, weight, activityLevel } = req.body;
    const updateData = {};

    // Handle height: either feet/inches OR cm
    if (heightCm !== undefined) {
      // User provided height in cm
      updateData.height = {
        cm: parseFloat(heightCm)
      };
    } else if (heightFeet !== undefined || heightInches !== undefined) {
      // User provided height in feet/inches
      updateData.height = {
        feet: heightFeet !== undefined ? parseInt(heightFeet) : 0,
        inches: heightInches !== undefined ? parseInt(heightInches) : 0
      };
    }
    if (weight !== undefined) updateData.weight = weight;
    if (activityLevel !== undefined) updateData.activityLevel = activityLevel;


    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }


    res.json({
      success: true,
      message: 'Body info updated successfully',
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update body info',
      error: error.message
    });
  }
};

/**
 * Update health conditions
 */
export const updateHealthConditions = async (req, res) => {
  try {
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const {
      healthConditions,
      medications,
      diabetesType,
      fastingSugar,
      hba1c
    } = req.body;
    const updateData = {};

    if (healthConditions !== undefined) updateData.healthConditions = healthConditions;
    if (medications !== undefined) updateData.medications = medications;
    if (diabetesType !== undefined) updateData.diabetesType = diabetesType;
    if (fastingSugar !== undefined && fastingSugar !== null && fastingSugar !== '') {
      updateData.fastingSugar = Number(fastingSugar);
    }
    if (hba1c !== undefined && hba1c !== null && hba1c !== '') {
      updateData.hba1c = Number(hba1c);
    }


    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }


    res.json({
      success: true,
      message: 'Health profile updated successfully',
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update health profile',
      error: error.message
    });
  }
};

/**
 * Update diet preferences
 */
export const updateDietPreferences = async (req, res) => {
  try {
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[updateDietPreferences] ❌ Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const {
      dietPreferences,
      foodLikes,
      foodDislikes,
      localFoodPreferences,
      budget,
      cookingTime
    } = req.body;

    const existingUser = await User.findById(req.userId).select('dietPreferences');
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const updateData = {};

    if (dietPreferences !== undefined && dietPreferences !== null && typeof dietPreferences === 'object') {
      const prev = existingUser.dietPreferences && typeof existingUser.dietPreferences.toObject === 'function'
        ? existingUser.dietPreferences.toObject()
        : (existingUser.dietPreferences || {});
      updateData.dietPreferences = { ...prev, ...dietPreferences };
    }

    if (Array.isArray(foodLikes)) updateData.foodLikes = foodLikes;
    if (Array.isArray(foodDislikes)) updateData.foodDislikes = foodDislikes;
    if (Array.isArray(localFoodPreferences)) updateData.localFoodPreferences = localFoodPreferences;
    if (budget !== undefined && budget !== null && budget !== '') updateData.budget = budget;
    if (cookingTime !== undefined && cookingTime !== null && cookingTime !== '') updateData.cookingTime = cookingTime;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No diet fields to update'
      });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'Diet preferences updated successfully',
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update diet preferences',
      error: error.message
    });
  }
};

/**
 * Update settings
 */
export const updateSettings = async (req, res) => {
  try {
    const { settings } = req.body;

    const existing = await User.findById(req.userId).select('settings');
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const prev = existing.settings && typeof existing.settings.toObject === 'function'
      ? existing.settings.toObject()
      : (existing.settings || {});
    const merged = { ...prev, ...(settings && typeof settings === 'object' ? settings : {}) };

    const user = await User.findByIdAndUpdate(
      req.userId,
      { settings: merged },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'Settings updated successfully',
      user
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update settings',
      error: error.message
    });
  }
};

/**
 * Complete onboarding
 */
export const completeOnboarding = async (req, res) => {
  try {

    const user = await User.findByIdAndUpdate(
      req.userId,
      { onboardingComplete: true },
      { new: true }
    ).select('-password');

    if (!user) {
      console.log('[completeOnboarding] ❌ User not found:', req.userId);
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }


    res.json({
      success: true,
      message: 'Onboarding completed',
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to complete onboarding',
      error: error.message
    });
  }
};

/**
 * Delete account
 */
export const deleteAccount = async (req, res) => {
  try {
    await User.findByIdAndDelete(req.userId);
    res.json({
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete account',
      error: error.message
    });
  }
};
