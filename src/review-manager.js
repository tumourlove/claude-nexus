class ReviewManager {
  constructor() {
    this.reviews = new Map();
    this.reviewCounter = 0;
  }

  submitForReview(submitterId, { files, description }) {
    const id = `review-${Date.now()}-${++this.reviewCounter}`;
    const review = {
      id,
      submitter: submitterId,
      files,
      description,
      status: 'pending',
      reviewer: null,
      comments: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.reviews.set(id, review);
    return id;
  }

  claimReview(reviewerId, reviewId) {
    const review = this.reviews.get(reviewId);
    if (!review) throw new Error(`Review "${reviewId}" not found`);
    if (review.status !== 'pending') throw new Error(`Review is already ${review.status}`);
    if (review.submitter === reviewerId) throw new Error('Cannot review your own submission');
    review.reviewer = reviewerId;
    review.status = 'in_review';
    review.updatedAt = Date.now();
    return { ...review };
  }

  approveReview(reviewerId, reviewId, comment) {
    const review = this.reviews.get(reviewId);
    if (!review) throw new Error(`Review "${reviewId}" not found`);
    if (review.reviewer !== reviewerId) throw new Error('Only the assigned reviewer can approve');
    review.status = 'approved';
    review.updatedAt = Date.now();
    if (comment) {
      review.comments.push({ file: null, line: null, comment, author: reviewerId, type: 'approval', timestamp: Date.now() });
    }
    return { ...review };
  }

  requestChanges(reviewerId, reviewId, comments) {
    const review = this.reviews.get(reviewId);
    if (!review) throw new Error(`Review "${reviewId}" not found`);
    if (review.reviewer !== reviewerId) throw new Error('Only the assigned reviewer can request changes');
    review.status = 'changes_requested';
    review.updatedAt = Date.now();
    for (const c of comments) {
      review.comments.push({ file: c.file, line: c.line, comment: c.comment, author: reviewerId, type: 'change_request', timestamp: Date.now() });
    }
    return { ...review };
  }

  getReview(reviewId) {
    const review = this.reviews.get(reviewId);
    if (!review) return null;
    return { ...review };
  }

  listReviews(filter) {
    const results = [];
    for (const review of this.reviews.values()) {
      if (!filter || review.status === filter) {
        results.push({ ...review });
      }
    }
    return results;
  }
}

module.exports = { ReviewManager };
