export const subscriptionPlanDefinitions = Object.freeze([
  {
    planId: 'free', name: 'Free', price: 0, billingInterval: 'month', currency: 'INR', isActive: true,
    features: {
      basicPlayback: true, basicPlaylists: true, basicRecommendations: true, aiDj: true,
      joinPublicLounges: true, listeningHistory: true, createPrivateLounges: false,
      advancedRecommendations: false, personalizedTransitions: false, advancedPlaylistManagement: false,
      detailedListeningStatistics: false, premiumThemes: false, additionalCollaborativeControls: false,
      advancedSessionAnalytics: false, advancedAcousticInsights: false, priorityAiProcessing: false,
    },
    usageLimits: { aiDjRequestsPerDay: 100, loungeCapacity: 8 },
    implementedFeatures: ['basicPlayback', 'basicPlaylists', 'basicRecommendations', 'aiDj', 'listeningHistory', 'loungeCapacity'],
  },
  {
    planId: 'premium', name: 'Premium', price: 149, billingInterval: 'month', currency: 'INR', isActive: true,
    features: {
      basicPlayback: true, basicPlaylists: true, basicRecommendations: true, aiDj: true,
      joinPublicLounges: true, listeningHistory: true, createPrivateLounges: true,
      advancedRecommendations: true, personalizedTransitions: true, advancedPlaylistManagement: true,
      detailedListeningStatistics: true, premiumThemes: true, additionalCollaborativeControls: true,
      advancedSessionAnalytics: false, advancedAcousticInsights: false, priorityAiProcessing: false,
    },
    usageLimits: { aiDjRequestsPerDay: 500, loungeCapacity: 20 },
    implementedFeatures: ['basicPlayback', 'basicPlaylists', 'basicRecommendations', 'aiDj', 'listeningHistory', 'loungeCapacity'],
  },
  {
    planId: 'pro', name: 'Pro', price: 299, billingInterval: 'month', currency: 'INR', isActive: true,
    features: {
      basicPlayback: true, basicPlaylists: true, basicRecommendations: true, aiDj: true,
      joinPublicLounges: true, listeningHistory: true, createPrivateLounges: true,
      advancedRecommendations: true, personalizedTransitions: true, advancedPlaylistManagement: true,
      detailedListeningStatistics: true, premiumThemes: true, additionalCollaborativeControls: true,
      advancedSessionAnalytics: true, advancedAcousticInsights: true, priorityAiProcessing: false,
    },
    usageLimits: { aiDjRequestsPerDay: 1500, loungeCapacity: 50 },
    implementedFeatures: ['basicPlayback', 'basicPlaylists', 'basicRecommendations', 'aiDj', 'listeningHistory', 'loungeCapacity'],
  },
]);

export const subscriptionPlanById = new Map(subscriptionPlanDefinitions.map((plan) => [plan.planId, plan]));
